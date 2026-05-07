import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Flow, JSONRPCResponse } from "flow-launcher-helper";
import malScraper, { AnimeSearchModel, MangaSearchModel } from "mal-scraper";

const search = malScraper.search;

const AUTH_FILE = path.join(process.cwd(), ".mal-auth.json");
const LEGACY_AUTH_FILE = path.join(process.cwd(), ".mal-auth");
const MAL_API_BASE = "https://api.myanimelist.net/v2";
const MAL_AUTHORIZE_URL = "https://myanimelist.net/v1/oauth2/authorize";
const MAL_TOKEN_URL = "https://myanimelist.net/v1/oauth2/token";
const AUTH_SERVER_HOST = "127.0.0.1";
const AUTH_SERVER_PORT = 53142;
const AUTH_REDIRECT_URI = `http://${AUTH_SERVER_HOST}:${AUTH_SERVER_PORT}/callback`;
const AUTH_SERVER_SCRIPT = path.join(process.cwd(), "build", "authServer.js");

type SearchType = "anime" | "manga";
type ListAction = "add" | "update";
type FlowActionMethod = "Flow.Launcher.OpenUrl" | "Flow.Launcher.ShowMsg";
type Methods = FlowActionMethod | "finish_auth" | "update_list" | "logout";
type ListPayload = Record<string, string>;

interface Settings {
  searchType?: SearchType;
  clientId?: string;
  clientSecret?: string;
  apiKey?: string;
  accessToken?: string;
  refreshToken?: string;
}

interface StoredAuth {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  pendingAuth?: {
    codeVerifier: string;
    state: string;
    createdAt: number;
  };
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
}

interface SearchItem {
  id: number;
  title: string;
  url: string;
  subtitle: string;
  thumbnail?: string;
}

interface OfficialSearchResponse {
  data?: {
    node: {
      id: number;
      title: string;
      main_picture?: {
        medium?: string;
        large?: string;
      };
      synopsis?: string;
      mean?: number;
      media_type?: string;
      num_episodes?: number;
      num_chapters?: number;
      num_volumes?: number;
      my_list_status?: {
        status?: string;
        score?: number;
        num_episodes_watched?: number;
        num_chapters_read?: number;
        num_volumes_read?: number;
      };
    };
  }[];
}

type Command =
  | { kind: "empty" }
  | { kind: "auth"; codeText?: string }
  | { kind: "logout" }
  | { kind: "search"; searchType: SearchType; term: string }
  | {
      kind: "list";
      action: ListAction;
      searchType: SearchType;
      term: string;
      payload: ListPayload;
      warnings: string[];
    };

const flow = new Flow<Methods, Settings>("public/app.png");
const { showResult, on, run } = flow;
const settings: Settings = flow.settings ?? {};

on("query", async (queryParams) => {
  try {
    const command = parseCommand(getQueryText(queryParams));

    if (command.kind === "empty") {
      return showWaiting();
    }

    if (command.kind === "auth") {
      return handleAuthQuery(command.codeText);
    }

    if (command.kind === "logout") {
      return showResult({
        title: "Sign out of MyAnimeList",
        subtitle: "Remove the locally saved OAuth token for this plugin.",
        method: "logout",
      });
    }

    if (command.kind === "list") {
      return await handleListQuery(command);
    }

    return await handleSearchQuery(command);
  } catch (error) {
    return showError("Unable to run MyAnimeList query", error);
  }
});

on("finish_auth", async (actionParams) => {
  try {
    const codeText = String(actionParams[0] ?? "");
    const { code, state } = extractAuthCode(codeText);
    const storedAuth = readStoredAuth();
    const pendingAuth = storedAuth.pendingAuth;
    const clientId = getClientId();
    const clientSecret = getClientSecret();

    if (!clientId) {
      throw new Error("Add your MyAnimeList Client ID in the plugin settings first.");
    }

    if (!clientSecret) {
      throw new Error("Add your MyAnimeList Client Secret in the plugin settings first.");
    }

    if (!pendingAuth) {
      throw new Error("Start with mal auth before exchanging an authorization code.");
    }

    if (state && state !== pendingAuth.state) {
      throw new Error("The OAuth state from MAL did not match this plugin's pending sign-in.");
    }

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: pendingAuth.codeVerifier,
      redirect_uri: AUTH_REDIRECT_URI,
      client_secret: clientSecret,
    });

    const token = await requestToken(body);
    saveToken(token, {
      ...storedAuth,
      pendingAuth: undefined,
    });

    return showActionMessage("Signed in to MyAnimeList", "You can now use mal add and mal update.");
  } catch (error) {
    return showActionMessage("Unable to finish MAL sign-in", formatError(error));
  }
});

on("update_list", async (actionParams) => {
  try {
    const searchType = String(actionParams[0]) as SearchType;
    const id = Number(actionParams[1]);
    const title = String(actionParams[2] ?? "this entry");
    const payload = JSON.parse(String(actionParams[3] ?? "{}")) as ListPayload;
    const action = String(actionParams[4] ?? "update") as ListAction;

    if (!isSearchType(searchType) || !Number.isInteger(id)) {
      throw new Error("The selected MAL result is missing a valid type or ID.");
    }

    const accessToken = await getAccessToken(true);
    if (!accessToken) {
      throw new Error("Connect your MAL account with mal auth, or add an access token in settings.");
    }

    const listStatus = await updateMyListStatus(searchType, id, payload, accessToken);
    const actionTitle = action === "add" ? "Added to MyAnimeList" : "Updated MyAnimeList entry";

    return showActionMessage(`${actionTitle}: ${title}`, formatListStatus(listStatus, searchType));
  } catch (error) {
    return showActionMessage("Unable to update your MAL list", formatError(error));
  }
});

on("logout", () => {
  try {
    if (existsSync(AUTH_FILE)) {
      unlinkSync(AUTH_FILE);
    }

    return showActionMessage("Signed out of MyAnimeList", "The locally saved OAuth token has been removed.");
  } catch (error) {
    return showActionMessage("Unable to sign out", formatError(error));
  }
});

run();

async function handleSearchQuery(command: Extract<Command, { kind: "search" }>): Promise<void> {
  if (command.term.length <= 2) {
    return showWaiting();
  }

  const results = await searchMal(command.searchType, command.term);
  if (results.length === 0) {
    return showResult({
      title: "No MyAnimeList results found",
      subtitle: `No ${command.searchType} matched "${command.term}".`,
    });
  }

  return showResult(
    ...results.map((item): JSONRPCResponse<Methods> => ({
      title: item.title,
      subtitle: item.subtitle,
      method: "Flow.Launcher.OpenUrl",
      params: [item.url, false],
      iconPath: item.thumbnail,
    })),
  );
}

async function handleListQuery(command: Extract<Command, { kind: "list" }>): Promise<void> {
  if (!hasWritableAuthCandidate()) {
    const authResult = getClientId() ? createAuthResult("Connect MyAnimeList before editing your list") : undefined;
    return showResult({
      title: authResult?.title ?? "Connect MyAnimeList before editing your list",
      subtitle: authResult?.subtitle ?? "Add a MAL Client ID or access token in the plugin settings first.",
      method: authResult?.method,
      params: authResult?.params,
    });
  }

  if (command.term.length <= 2) {
    return showResult({
      title: `Type a ${command.searchType} title to ${command.action}`,
      subtitle: `${formatUsage(command.action)} ${formatPayloadHint(command.searchType)}`,
    });
  }

  if (command.action === "update" && Object.keys(command.payload).length === 0) {
    return showResult({
      title: "Tell MAL what to update",
      subtitle: `${formatUsage("update")} ${formatPayloadHint(command.searchType)}`,
    });
  }

  const results = await searchMal(command.searchType, command.term);
  if (results.length === 0) {
    return showResult({
      title: "No MyAnimeList results found",
      subtitle: `No ${command.searchType} matched "${command.term}".`,
    });
  }

  const warningPrefix = command.warnings.length > 0 ? `${command.warnings[0]} | ` : "";
  const actionLabel = command.action === "add" ? "Add" : "Update";

  return showResult(
    ...results.map((item): JSONRPCResponse<Methods> => ({
      title: `${actionLabel} ${item.title}`,
      subtitle: `${warningPrefix}${formatPayload(command.payload, command.searchType)} | ${item.subtitle}`,
      method: "update_list",
      params: [
        command.searchType,
        item.id,
        item.title,
        JSON.stringify(command.payload),
        command.action,
      ],
      iconPath: item.thumbnail,
    })),
  );
}

function handleAuthQuery(codeText?: string): void {
  const clientId = getClientId();
  if (codeText) {
    return showResult({
      title: "Finish MyAnimeList sign-in",
      subtitle: "Exchange this authorization code for a local OAuth token.",
      method: "finish_auth",
      params: [codeText],
    });
  }

  if (!clientId) {
    return showResult({
      title: "Missing MAL Client ID",
      subtitle: "Add your MyAnimeList Client ID in the plugin settings first.",
    });
  }

  if (!getClientSecret()) {
    return showResult({
      title: "Missing MAL Client Secret",
      subtitle: "Add your MyAnimeList Client Secret in the plugin settings before using mal auth.",
    });
  }

  const storedAuth = readStoredAuth();
  if (settings.accessToken || storedAuth.accessToken) {
    return showResult(
      {
        title: "MyAnimeList account is connected",
        subtitle: "Run mal logout to clear the local OAuth token, or re-run sign-in to replace it.",
      },
      createAuthResult("Re-authorize MyAnimeList", "Open MAL account sign-in again."),
    );
  }

  return showResult(createAuthResult("Sign in with MyAnimeList"));
}

function createAuthResult(title: string, subtitle = "Open MAL account authorization. After approving, run mal auth <code>."): JSONRPCResponse<Methods> {
  const clientId = getClientId();
  if (!clientId) {
    return {
      title: "Missing MAL Client ID",
      subtitle: "Add your MyAnimeList Client ID in the plugin settings first.",
    };
  }

  const clientSecret = getClientSecret();
  if (!clientSecret) {
    return {
      title: "Missing MAL Client Secret",
      subtitle: "Add your MyAnimeList Client Secret in the plugin settings first.",
    };
  }

  const authUrl = createAuthorizationUrl(clientId);
  startAuthServer(clientId, clientSecret);
  return {
    title,
    subtitle: `${subtitle} Redirect URI: ${AUTH_REDIRECT_URI}`,
    method: "Flow.Launcher.OpenUrl",
    params: [authUrl, false],
  };
}

function startAuthServer(clientId: string, clientSecret: string): void {
  const child = spawn(process.execPath, [AUTH_SERVER_SCRIPT], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: {
      ...process.env,
      MAL_AUTH_FILE: AUTH_FILE,
      MAL_CLIENT_ID: clientId,
      MAL_CLIENT_SECRET: clientSecret,
      MAL_REDIRECT_URI: AUTH_REDIRECT_URI,
      MAL_AUTH_HOST: AUTH_SERVER_HOST,
      MAL_AUTH_PORT: String(AUTH_SERVER_PORT),
      MAL_AUTH_TIMEOUT_MS: String(5 * 60 * 1000),
    },
  });

  child.unref();
}

function parseCommand(rawQuery: string): Command {
  const tokens = stripActionKeyword(tokenize(rawQuery));
  if (tokens.length === 0) {
    return { kind: "empty" };
  }

  const first = tokens[0].toLowerCase();
  if (first === "auth" || first === "login") {
    const codeText = tokens.slice(1).join(" ").trim();
    return {
      kind: "auth",
      codeText: codeText || undefined,
    };
  }

  if (first === "logout" || first === "signout") {
    return { kind: "logout" };
  }

  if (first === "add" || first === "update") {
    return parseListCommand(first, tokens.slice(1));
  }

  return parseSearchCommand(tokens);
}

function stripActionKeyword(tokens: string[]): string[] {
  if (tokens[0]?.toLowerCase() === "mal") {
    return tokens.slice(1);
  }

  return tokens;
}

function parseSearchCommand(tokens: string[]): Command {
  const firstType = normalizeSearchType(tokens[0]);
  const searchType = firstType ?? settings.searchType ?? "anime";
  const term = (firstType ? tokens.slice(1) : tokens).join(" ").trim();

  if (!term) {
    return { kind: "empty" };
  }

  return {
    kind: "search",
    searchType,
    term,
  };
}

function parseListCommand(action: ListAction, tokens: string[]): Command {
  const firstType = normalizeSearchType(tokens[0]);
  const searchType = firstType ?? settings.searchType ?? "anime";
  const fieldTokens = firstType ? tokens.slice(1) : tokens;
  const { payload, queryTokens, warnings } = parseListFields(searchType, fieldTokens);

  if (action === "add" && !payload.status) {
    payload.status = searchType === "anime" ? "plan_to_watch" : "plan_to_read";
  }

  return {
    kind: "list",
    action,
    searchType,
    term: queryTokens.join(" ").trim(),
    payload,
    warnings,
  };
}

function parseListFields(searchType: SearchType, tokens: string[]): {
  payload: ListPayload;
  queryTokens: string[];
  warnings: string[];
} {
  const payload: ListPayload = {};
  const queryTokens: string[] = [];
  const warnings: string[] = [];

  for (const token of tokens) {
    const keyValue = splitKnownKeyValue(token);

    if (keyValue) {
      const warning = applyPayloadField(searchType, payload, keyValue.key, keyValue.value);
      if (warning) {
        warnings.push(warning);
      }
      continue;
    }

    const status = normalizeStatus(searchType, token);
    if (status && !payload.status) {
      payload.status = status;
      continue;
    }

    queryTokens.push(token);
  }

  return {
    payload,
    queryTokens,
    warnings,
  };
}

function applyPayloadField(
  searchType: SearchType,
  payload: ListPayload,
  key: string,
  value: string,
): string | undefined {
  const normalizedKey = key.toLowerCase().replace(/-/g, "_");
  const normalizedValue = value.trim();

  if (normalizedKey === "status") {
    const status = normalizeStatus(searchType, normalizedValue);
    if (!status) {
      return `Ignored invalid status "${value}"`;
    }
    payload.status = status;
    return undefined;
  }

  if (normalizedKey === "score") {
    const score = parseInteger(normalizedValue);
    if (score === undefined || score < 0 || score > 10) {
      return `Ignored invalid score "${value}"`;
    }
    payload.score = String(score);
    return undefined;
  }

  if (["priority", "num_times_rewatched", "num_times_reread", "rewatch_value", "reread_value"].includes(normalizedKey)) {
    const number = parseInteger(normalizedValue);
    if (number === undefined || number < 0) {
      return `Ignored invalid ${key} "${value}"`;
    }
    payload[normalizedKey] = String(number);
    return undefined;
  }

  if (["tags", "comments", "start_date", "finish_date"].includes(normalizedKey)) {
    payload[normalizedKey] = normalizedValue;
    return undefined;
  }

  if (["start", "started"].includes(normalizedKey)) {
    payload.start_date = normalizedValue;
    return undefined;
  }

  if (["finish", "finished", "end", "ended"].includes(normalizedKey)) {
    payload.finish_date = normalizedValue;
    return undefined;
  }

  if (["rewatch", "rewatching", "reread", "rereading"].includes(normalizedKey)) {
    payload[searchType === "anime" ? "is_rewatching" : "is_rereading"] = parseBoolean(normalizedValue) ? "true" : "false";
    return undefined;
  }

  if (searchType === "anime" && ["eps", "ep", "episodes", "episode", "watched"].includes(normalizedKey)) {
    const episodes = parseInteger(normalizedValue);
    if (episodes === undefined || episodes < 0) {
      return `Ignored invalid episode count "${value}"`;
    }
    payload.num_watched_episodes = String(episodes);
    return undefined;
  }

  if (searchType === "manga" && ["chapters", "chapter", "ch", "read"].includes(normalizedKey)) {
    const chapters = parseInteger(normalizedValue);
    if (chapters === undefined || chapters < 0) {
      return `Ignored invalid chapter count "${value}"`;
    }
    payload.num_chapters_read = String(chapters);
    return undefined;
  }

  if (searchType === "manga" && ["volumes", "volume", "vols", "vol"].includes(normalizedKey)) {
    const volumes = parseInteger(normalizedValue);
    if (volumes === undefined || volumes < 0) {
      return `Ignored invalid volume count "${value}"`;
    }
    payload.num_volumes_read = String(volumes);
    return undefined;
  }

  return `Ignored unknown field "${key}"`;
}

async function searchMal(searchType: SearchType, term: string): Promise<SearchItem[]> {
  const officialResults = await searchOfficialApi(searchType, term);
  if (officialResults.length > 0) {
    return officialResults;
  }

  const scraperResults = await search.search(searchType, {
    term,
    maxResults: 15,
  });

  return scraperResults
    .map((result) => fromScraperResult(searchType, result))
    .filter((result): result is SearchItem => result !== undefined)
    .slice(0, 15);
}

async function searchOfficialApi(searchType: SearchType, term: string): Promise<SearchItem[]> {
  const headers = await getReadHeaders();
  if (!headers) {
    return [];
  }

  const fields =
    searchType === "anime"
      ? "id,title,main_picture,synopsis,mean,media_type,num_episodes,my_list_status"
      : "id,title,main_picture,synopsis,mean,media_type,num_chapters,num_volumes,my_list_status";
  const url = new URL(`${MAL_API_BASE}/${searchType}`);
  url.searchParams.set("q", term);
  url.searchParams.set("limit", "15");
  url.searchParams.set("fields", fields);

  const response = await fetch(url, {
    headers,
  });

  if (!response.ok) {
    return [];
  }

  const data = (await response.json()) as OfficialSearchResponse;
  return (data.data ?? []).map(({ node }) => {
    const details = [
      node.media_type,
      node.mean ? `score ${node.mean}` : undefined,
      searchType === "anime" && node.num_episodes ? `${node.num_episodes} eps` : undefined,
      searchType === "manga" && node.num_chapters ? `${node.num_chapters} ch` : undefined,
      searchType === "manga" && node.num_volumes ? `${node.num_volumes} vol` : undefined,
      node.my_list_status?.status ? `your list: ${formatStatusName(node.my_list_status.status)}` : undefined,
    ].filter(Boolean);

    const synopsis = cleanText(node.synopsis ?? "");
    return {
      id: node.id,
      title: node.title,
      url: toMalUrl(searchType, node.id),
      thumbnail: node.main_picture?.medium ?? node.main_picture?.large,
      subtitle: details.length > 0 ? `${details.join(" | ")} | ${truncate(synopsis, 90)}` : truncate(synopsis, 120),
    };
  });
}

function fromScraperResult(searchType: SearchType, result: AnimeSearchModel | MangaSearchModel): SearchItem | undefined {
  const id = extractMalId(result.url);
  if (!id) {
    return undefined;
  }

  const details =
    searchType === "anime"
      ? [
          result.type,
          "score" in result ? formatOptionalDetail("score", String(result.score)) : undefined,
          "nbEps" in result ? formatOptionalDetail(undefined, String(result.nbEps), "eps") : undefined,
        ]
      : [
          result.type,
          "score" in result ? formatOptionalDetail("score", String(result.score)) : undefined,
          "nbChapters" in result ? formatOptionalDetail(undefined, String(result.nbChapters), "ch") : undefined,
        ];
  const summary = cleanText(result.shortDescription);
  const subtitleParts = [...details.filter(Boolean), truncate(summary, 90)];

  return {
    id,
    title: result.title,
    url: result.url,
    thumbnail: result.thumbnail,
    subtitle: subtitleParts.join(" | "),
  };
}

async function updateMyListStatus(
  searchType: SearchType,
  id: number,
  payload: ListPayload,
  accessToken: string,
): Promise<unknown> {
  const response = await fetch(`${MAL_API_BASE}/${searchType}/${id}/my_list_status`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(payload),
  });

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  return await response.json();
}

async function getReadHeaders(): Promise<Record<string, string> | undefined> {
  const accessToken = await getAccessToken(false);
  if (accessToken) {
    return {
      Authorization: `Bearer ${accessToken}`,
    };
  }

  const clientId = getClientId();
  if (clientId) {
    return {
      "X-MAL-CLIENT-ID": clientId,
    };
  }

  return undefined;
}

async function getAccessToken(refreshIfNeeded: boolean): Promise<string | undefined> {
  if (settings.accessToken) {
    return settings.accessToken;
  }

  const storedAuth = readStoredAuth();
  if (
    storedAuth.accessToken &&
    (!refreshIfNeeded || !storedAuth.expiresAt || storedAuth.expiresAt > Date.now() + 60_000)
  ) {
    return storedAuth.accessToken;
  }

  const refreshToken = settings.refreshToken ?? storedAuth.refreshToken;
  const clientId = getClientId();
  if (!refreshIfNeeded || !refreshToken || !clientId) {
    return storedAuth.accessToken;
  }

  const clientSecret = getClientSecret();
  if (!clientSecret) {
    throw new Error("Add your MyAnimeList Client Secret in the plugin settings to refresh OAuth tokens.");
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: refreshToken,
    client_secret: clientSecret,
  });

  const token = await requestToken(body);
  saveToken(token, storedAuth);
  return token.access_token;
}

async function requestToken(body: URLSearchParams): Promise<TokenResponse> {
  const response = await fetch(MAL_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  return (await response.json()) as TokenResponse;
}

function saveToken(token: TokenResponse, storedAuth: StoredAuth): void {
  writeStoredAuth({
    ...storedAuth,
    accessToken: token.access_token,
    refreshToken: token.refresh_token ?? storedAuth.refreshToken,
    expiresAt: token.expires_in ? Date.now() + token.expires_in * 1000 : undefined,
    pendingAuth: undefined,
  });
}

function hasWritableAuthCandidate(): boolean {
  const storedAuth = readStoredAuth();
  return Boolean(settings.accessToken || settings.refreshToken || storedAuth.accessToken || storedAuth.refreshToken);
}

function readStoredAuth(): StoredAuth {
  const authFile = getStoredAuthFile();
  if (!authFile) {
    return {};
  }

  try {
    return JSON.parse(readFileSync(authFile, "utf8")) as StoredAuth;
  } catch {
    return {};
  }
}

function writeStoredAuth(auth: StoredAuth): void {
  writeFileSync(getWritableAuthFile(), JSON.stringify(auth, null, 2), "utf8");
}

function getStoredAuthFile(): string | undefined {
  if (existsSync(AUTH_FILE)) {
    return AUTH_FILE;
  }

  if (existsSync(LEGACY_AUTH_FILE)) {
    return LEGACY_AUTH_FILE;
  }

  return undefined;
}

function getWritableAuthFile(): string {
  if (!existsSync(AUTH_FILE) && existsSync(LEGACY_AUTH_FILE)) {
    return LEGACY_AUTH_FILE;
  }

  return AUTH_FILE;
}

async function readApiError(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const data = JSON.parse(text) as Record<string, unknown>;
    const message = data.message ?? data.error_description ?? data.error;
    if (message) {
      return `${response.status} ${response.statusText}: ${String(message)}`;
    }
  } catch {
    // Fall back to the raw response text below.
  }

  return `${response.status} ${response.statusText}${text ? `: ${text}` : ""}`;
}

function getClientId(): string | undefined {
  return normalizeSetting(settings.clientId ?? settings.apiKey);
}

function getClientSecret(): string | undefined {
  return normalizeSetting(settings.clientSecret);
}

function normalizeSetting(value?: string): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function tokenize(input: string): string[] {
  return (input.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((token) => {
    if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
      return token.slice(1, -1);
    }
    return token;
  });
}

function getQueryText(queryParams: unknown): string {
  if (!Array.isArray(queryParams)) {
    return "";
  }

  return queryParams.map((param) => String(param)).join(" ").trim();
}

function splitKnownKeyValue(token: string): { key: string; value: string } | undefined {
  const equalsIndex = token.indexOf("=");
  const separatorIndex = equalsIndex >= 0 ? equalsIndex : token.indexOf(":");
  if (separatorIndex <= 0) {
    return undefined;
  }

  const key = token.slice(0, separatorIndex).trim();
  if (!isKnownPayloadKey(key)) {
    return undefined;
  }

  return {
    key,
    value: token.slice(separatorIndex + 1).trim(),
  };
}

function isKnownPayloadKey(key: string): boolean {
  const normalizedKey = key.toLowerCase().replace(/-/g, "_");
  return [
    "status",
    "score",
    "eps",
    "ep",
    "episodes",
    "episode",
    "watched",
    "chapters",
    "chapter",
    "ch",
    "read",
    "volumes",
    "volume",
    "vols",
    "vol",
    "priority",
    "tags",
    "comments",
    "start_date",
    "finish_date",
    "start",
    "started",
    "finish",
    "finished",
    "end",
    "ended",
    "rewatch",
    "rewatching",
    "reread",
    "rereading",
    "num_times_rewatched",
    "num_times_reread",
    "rewatch_value",
    "reread_value",
  ].includes(normalizedKey);
}

function normalizeSearchType(value?: string): SearchType | undefined {
  const normalized = value?.toLowerCase();
  return isSearchType(normalized) ? normalized : undefined;
}

function isSearchType(value?: string): value is SearchType {
  return value === "anime" || value === "manga";
}

function normalizeStatus(searchType: SearchType, value: string): string | undefined {
  const normalized = value.toLowerCase().replace(/\s+/g, "_").replace(/-/g, "_");

  if (["completed", "complete", "done"].includes(normalized)) {
    return "completed";
  }

  if (["on_hold", "onhold", "hold", "paused"].includes(normalized)) {
    return "on_hold";
  }

  if (["dropped", "drop"].includes(normalized)) {
    return "dropped";
  }

  if (searchType === "anime") {
    if (["watching", "watch", "w"].includes(normalized)) {
      return "watching";
    }
    if (["plan", "planned", "ptw", "plan_to_watch", "plantowatch"].includes(normalized)) {
      return "plan_to_watch";
    }
  }

  if (searchType === "manga") {
    if (["reading", "read", "r"].includes(normalized)) {
      return "reading";
    }
    if (["plan", "planned", "ptr", "plan_to_read", "plantoread"].includes(normalized)) {
      return "plan_to_read";
    }
  }

  return undefined;
}

function parseInteger(value: string): number | undefined {
  if (!/^\d+$/.test(value)) {
    return undefined;
  }

  return Number(value);
}

function parseBoolean(value: string): boolean {
  return ["1", "true", "yes", "y", "on"].includes(value.toLowerCase());
}

function createAuthorizationUrl(clientId: string): string {
  const codeVerifier = createCodeVerifier();
  const state = randomString(24);
  const storedAuth = readStoredAuth();
  writeStoredAuth({
    ...storedAuth,
    pendingAuth: {
      codeVerifier,
      state,
      createdAt: Date.now(),
    },
  });

  const url = new URL(MAL_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", AUTH_REDIRECT_URI);
  url.searchParams.set("code_challenge", codeVerifier);
  url.searchParams.set("code_challenge_method", "plain");
  url.searchParams.set("scope", "write:users");
  url.searchParams.set("state", state);

  return url.toString();
}

function createCodeVerifier(): string {
  return randomString(96).slice(0, 128);
}

function randomString(byteCount: number): string {
  return randomBytes(byteCount).toString("base64url");
}

function extractAuthCode(input: string): { code: string; state?: string } {
  const trimmed = input.trim();
  try {
    const url = new URL(trimmed);
    const code = url.searchParams.get("code");
    if (code) {
      return {
        code,
        state: url.searchParams.get("state") ?? undefined,
      };
    }
  } catch {
    // The user may paste only the code, which is handled below.
  }

  const codeMatch = trimmed.match(/(?:^|[?&#])code=([^&\s]+)/);
  if (codeMatch) {
    const stateMatch = trimmed.match(/(?:^|[?&#])state=([^&\s]+)/);
    return {
      code: decodeURIComponent(codeMatch[1]),
      state: stateMatch ? decodeURIComponent(stateMatch[1]) : undefined,
    };
  }

  if (!trimmed) {
    throw new Error("No authorization code was provided.");
  }

  return { code: trimmed };
}

function extractMalId(url: string): number | undefined {
  const idMatch = url.match(/myanimelist\.net\/(?:anime|manga)\/(\d+)/i);
  if (!idMatch) {
    return undefined;
  }

  return Number(idMatch[1]);
}

function toMalUrl(searchType: SearchType, id: number): string {
  return `https://myanimelist.net/${searchType}/${id}`;
}

function cleanText(value: string): string {
  return value.replace(/(\n\s?)/gm, " ").replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.substring(0, maxLength - 3)}...`;
}

function formatStatusName(status: string): string {
  return status.replace(/_/g, " ");
}

function formatOptionalDetail(label: string | undefined, value: string, suffix?: string): string | undefined {
  const normalized = value.trim();
  if (!normalized || normalized === "-") {
    return undefined;
  }

  return [label, normalized, suffix].filter(Boolean).join(" ");
}

function formatPayload(payload: ListPayload, searchType: SearchType): string {
  const labels: Record<string, string> = {
    status: "status",
    score: "score",
    num_watched_episodes: "eps",
    num_chapters_read: "chapters",
    num_volumes_read: "volumes",
    priority: "priority",
    tags: "tags",
    comments: "comments",
    start_date: "start",
    finish_date: "finish",
    is_rewatching: "rewatching",
    is_rereading: "rereading",
    num_times_rewatched: "rewatches",
    num_times_reread: "rereads",
    rewatch_value: "rewatch value",
    reread_value: "reread value",
  };

  const entries = Object.entries(payload).map(([key, value]) => {
    const label = labels[key] ?? key;
    const formattedValue = key === "status" ? formatStatusName(value) : value;
    return `${label}: ${formattedValue}`;
  });

  return entries.length > 0 ? entries.join(", ") : `no ${searchType} fields selected`;
}

function formatListStatus(listStatus: unknown, searchType: SearchType): string {
  if (!listStatus || typeof listStatus !== "object") {
    return "MAL accepted the list update.";
  }

  const data = listStatus as Record<string, unknown>;
  const fields = [
    typeof data.status === "string" ? `status: ${formatStatusName(data.status)}` : undefined,
    typeof data.score === "number" ? `score: ${data.score}` : undefined,
    searchType === "anime" && typeof data.num_episodes_watched === "number"
      ? `eps: ${data.num_episodes_watched}`
      : undefined,
    searchType === "manga" && typeof data.num_chapters_read === "number"
      ? `chapters: ${data.num_chapters_read}`
      : undefined,
    searchType === "manga" && typeof data.num_volumes_read === "number"
      ? `volumes: ${data.num_volumes_read}`
      : undefined,
  ].filter(Boolean);

  return fields.length > 0 ? fields.join(", ") : "MAL accepted the list update.";
}

function formatUsage(action: ListAction): string {
  return action === "add" ? "mal add anime Frieren watching score=9" : "mal update manga Berserk chapters=80 score=10";
}

function formatPayloadHint(searchType: SearchType): string {
  return searchType === "anime"
    ? "Fields: status, score=0-10, eps=12, start=YYYY-MM-DD, finish=YYYY-MM-DD."
    : "Fields: status, score=0-10, chapters=12, volumes=3, start=YYYY-MM-DD, finish=YYYY-MM-DD.";
}

function showWaiting(): void {
  showResult({
    title: "Waiting for query...",
    subtitle: "Search normally, or use mal auth, mal add, and mal update.",
  });
}

function showError(title: string, error: unknown): void {
  showResult({
    title,
    subtitle: formatError(error),
  });
}

function showActionMessage(title: string, subtitle: string): void {
  console.log(JSON.stringify({
    method: "Flow.Launcher.ShowMsg",
    parameters: [title, subtitle, "public/app.png"],
  }));
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
