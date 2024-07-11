var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
import { Flow } from "flow-launcher-helper";
import malScraper from "mal-scraper";
const search = malScraper.search;
const { params, showResult, on, run, settings } = new Flow("app.png");
on("query", () => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const data = yield search.search("anime", {
            term: params,
            maxResults: 15,
        });
        const results = [];
        data.forEach((data) => {
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
    }
    catch (err) {
        return showResult({
            title: "Uh oh... an error occured..",
            subtitle: err,
        });
    }
}));
on("open_result", () => {
    const url = params;
    open(url);
});
run();
