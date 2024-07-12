import open from 'open';
import { Flow, JSONRPCResponse } from "flow-launcher-helper";
import malScraper, { AnimeSearchModel, MangaSearchModel } from "mal-scraper";
const search = malScraper.search;

// console.log(search.helpers);

type Methods = "open_result";

interface Settings {
  searchType: "anime" | "manga"
}

const { params, showResult, on, run, settings } = new Flow<Methods, Settings>("public/app.png");

on("query", async () => {
  if (params.length <= 2) {
    return showResult({
      title: 'Waiting for query...',
    });
  }
  try {
    const searchQuery = params.includes("manga") ? "manga" : (settings.searchType ? settings.searchType : "anime")
    const data = await search.search(searchQuery, {
      term: params.replace("anime", "").replace("manga", ""),
      maxResults: 15,
    });

    const results: JSONRPCResponse<Methods>[] = [];

    data.forEach((data: AnimeSearchModel | MangaSearchModel) => {
      const subtitle = data.shortDescription
        .replace(/(\n\s?)/gm, "")
        .substring(0, 120);

      results.push({
        title: data.title,
        subtitle,
        method: "open_result",
        params: [data.url],
        iconPath: data.thumbnail,
      });
    });

    showResult(...results);
  } catch (err) {
    return showResult({
      title: "Uh oh... an error occured..",
      subtitle: err as string,
    });
  }
});

on("open_result", () => {
  const url = params;
  open(url);
});

run();
