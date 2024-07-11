// import open from 'open';
import { Flow, JSONRPCResponse } from "flow-launcher-helper";
import malScraper, { AnimeSearchModel } from "mal-scraper";
const search = malScraper.search;

// console.log(search.helpers);

type Methods = "open_result";

// interface Settings {
//   sort: string;
//   locale: string;
// }

const { params, showResult, on, run, settings } = new Flow<Methods>("app.png");

on("query", async () => {
  try {
    const data = await search.search("anime", {
      term: params,
      maxResults: 15,
    });

    const results: JSONRPCResponse<Methods>[] = [];

    data.forEach((data: AnimeSearchModel) => {
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
  } catch(err) {
    return showResult({
      title: "Uh oh... an error occured..",
      subtitle: err as string,
    });
  }
});

on("open_result", () => {
  const url = params
  open(url);
});

run();
