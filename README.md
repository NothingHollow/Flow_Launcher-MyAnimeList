# MyAnimeList for Flow Launcher

Search MyAnimeList from Flow Launcher and update your anime or manga list from the launcher.

- [x] Search anime and manga
- [x] Sign in with a MyAnimeList account using OAuth
- [x] Use a MAL Client ID / API key for official API search
- [x] Add anime or manga to your list
- [x] Update anime or manga list entries

## Authentication

The plugin supports these auth methods:

- **MAL account OAuth**: recommended for adding and updating list entries.
- **MAL Client ID / API key**: used for official API search. Search can also fall back to `mal-scraper`.
- **Manual OAuth tokens**: paste an access token and optional refresh token in plugin settings if you manage tokens elsewhere. Refreshing tokens requires the MAL Client Secret.

### OAuth Login

1. Create a MAL API client at <https://myanimelist.net/apiconfig>.
2. Set the app redirect URL to:

```text
http://127.0.0.1:53142/callback
```

3. Add the MAL Client ID and MAL Client Secret / API Secret in Flow's plugin settings.
4. Run:

```text
mal auth
```

5. Select **Sign in with MyAnimeList** and approve the MAL consent page.

The plugin starts a temporary local callback server on `127.0.0.1:53142`, exchanges the OAuth code, saves the token locally, then closes the server. Tokens are stored in `.mal-auth.json` and are ignored by git.

If the browser redirect does not finish automatically, copy the redirected URL or code and run:

```text
mal auth <code-or-redirect-url>
```

To clear saved auth:

```text
mal logout
```

## Search

```text
mal frieren
mal anime frieren
mal manga berserk
```

Without `anime` or `manga`, the plugin uses the default search type from settings.

## Add Entries

```text
mal add anime frieren watching score=9 eps=1
mal add manga berserk reading chapters=80 score=10
mal add the angel next door completed score=8 eps=12
```

`mal add` searches first. Select the correct result to add or update that entry on your MAL list.

If no status is provided, `add` defaults to:

- Anime: `plan_to_watch`
- Manga: `plan_to_read`

## Update Entries

```text
mal update anime frieren eps=2 score=9
mal update manga berserk chapters=81 volumes=14
mal update the angel next door completed score=8 eps=12
```

`mal update` also searches first. Select the result you want to update.

## Supported Fields

Statuses:

- Anime: `watching`, `completed`, `on_hold`, `dropped`, `plan_to_watch`
- Manga: `reading`, `completed`, `on_hold`, `dropped`, `plan_to_read`

Common fields:

- `status=<status>`
- `score=0-10`
- `priority=<number>`
- `tags=<text>`
- `comments=<text>`
- `start=YYYY-MM-DD` or `start_date=YYYY-MM-DD`
- `finish=YYYY-MM-DD` or `finish_date=YYYY-MM-DD`

Anime fields:

- `eps=<number>`
- `episodes=<number>`
- `rewatching=true`
- `num_times_rewatched=<number>`
- `rewatch_value=<number>`

Manga fields:

- `chapters=<number>`
- `volumes=<number>`
- `rereading=true`
- `num_times_reread=<number>`
- `reread_value=<number>`

Quoted text works for multi-word values:

```text
mal update anime frieren comments="rewatching with friends" tags="favorite fantasy"
```

## Troubleshooting

- If Flow says the token is missing write access, run `mal logout`, then `mal auth` again and approve the consent page.
- If OAuth opens but does not redirect back, confirm your MAL app redirect URL is exactly `http://127.0.0.1:53142/callback`.
- If you manually created `.mal-auth`, the plugin can read it, but new OAuth logins save to `.mal-auth.json`.

## Plugin Preview

![preview](https://github.com/NothingHollow/Flow_Launcher-MyAnimeList/blob/main/public/preview.png?raw=true)
![preview2](https://github.com/NothingHollow/Flow_Launcher-MyAnimeList/blob/main/public/preview2.png?raw=true)
