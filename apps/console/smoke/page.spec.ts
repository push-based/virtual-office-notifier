import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { extname, join, normalize } from "node:path";
import { gzipSync } from "node:zlib";

import { Predicate } from "effect";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

const CLIENT = join(import.meta.dirname, "../dist/client");

const SCRIPT_BUDGET_KB = 220;

const STARTUP_SCRIPT = /<(?:script[^>]+src|link[^>]+rel="modulepreload"[^>]+href)="\/([^"]+\.js)"/g;

const startupScripts = async (): Promise<ReadonlyArray<string>> =>
  Array.from(
    (await readFile(join(CLIENT, "index.html"), "utf8")).matchAll(STARTUP_SCRIPT),
    (match) => match[1] ?? "",
  );

const TYPES = new Map([
  [".html", "text/html"],
  [".js", "text/javascript"],
  [".css", "text/css"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
]);

const serveClient = (): Promise<Server> =>
  new Promise((ready) => {
    const server = createServer((request, response) => {
      const path = normalize(new URL(request.url ?? "/", "http://page.test").pathname);
      const file = join(CLIENT, path === "/" ? "index.html" : path);

      readFile(file).then(
        (body) => {
          response.writeHead(200, {
            "content-type": TYPES.get(extname(file)) ?? "application/octet-stream",
          });
          response.end(body);
        },
        () => {
          response.writeHead(404);
          response.end();
        },
      );
    });

    server.listen(0, "127.0.0.1", () => ready(server));
  });

const API = new Map<string, null | { readonly clientId: string }>([
  ["/api/telemetry", null],
  ["/api/config", { clientId: "client-1" }],
]);

const portOf = (listening: Server): number => {
  const address = listening.address();

  if (address === null || Predicate.isString(address)) {
    throw new Error("The page's server isn't listening on a port");
  }

  return address.port;
};

let server: Server;

let browser: Browser;

const ADOPTION_MARK = `
  document.addEventListener("readystatechange", () => {
    if (document.readyState === "interactive") {
      Object.defineProperty(window, "served", {
        value: {
          main: document.querySelector("main"),
          tab: document.querySelector("[role=tab]"),
        },
      });
    }
  });
`;

const openPage = async (
  options: { readonly javaScript?: boolean } = {},
): Promise<{ page: Page; errors: Array<string> }> => {
  const context = await browser.newContext({ javaScriptEnabled: options.javaScript ?? true });
  const page = await context.newPage();

  await page.addInitScript(ADOPTION_MARK);
  const errors: Array<string> = [];

  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/**", (route) => {
    const answer = API.get(new URL(route.request().url()).pathname);

    return answer === undefined
      ? route.fulfill({ status: 404 })
      : route.fulfill({ status: 200, json: answer });
  });

  await page.goto(`http://127.0.0.1:${portOf(server)}/`);

  return { page, errors };
};

beforeAll(async () => {
  server = await serveClient();
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser.close();
  server.close();
});

describe("the built page", () => {
  it(`starts with under ${SCRIPT_BUDGET_KB} kB of script, gzipped`, async () => {
    const scripts = await startupScripts();

    const sizes = await Promise.all(
      scripts.map(async (path) => gzipSync(await readFile(join(CLIENT, path))).byteLength),
    );

    const total = sizes.reduce((sum, size) => sum + size, 0) / 1000;

    expect(scripts.length).toBeGreaterThan(0);
    expect(total).toBeLessThanOrEqual(SCRIPT_BUDGET_KB);
  });

  it("loads no other script when the Worker has no Sentry to report to", async () => {
    const expected = await startupScripts();
    const page = await browser.newPage();
    const loaded: Array<string> = [];

    page.on("request", (request) => {
      const { pathname } = new URL(request.url());

      if (pathname.endsWith(".js")) loaded.push(pathname.slice(1));
    });
    await page.route("**/api/**", (route) => {
      const answer = API.get(new URL(route.request().url()).pathname);

      return answer === undefined
        ? route.fulfill({ status: 404 })
        : route.fulfill({ status: 200, json: answer });
    });
    await page.goto(`http://127.0.0.1:${portOf(server)}/`);
    await expect.poll(() => page.getByRole("heading", { name: "Couldn't start" }).count()).toBe(1);

    expect(loaded.sort()).toEqual([...expected].sort());

    await page.close();
  });

  it("starts in a real browser, and says it couldn't start outside Discord", async () => {
    const { page, errors } = await openPage();

    await expect.poll(() => page.getByRole("heading", { name: "Couldn't start" }).count()).toBe(1);
    expect(await page.getByRole("tab").allTextContents()).toEqual([
      "Now",
      "History",
      "Stats",
      "Privacy",
    ]);
    expect(errors).toEqual([]);

    await page.close();
  });

  it("arrives already rendered, before any script runs", async () => {
    const { page } = await openPage({ javaScript: false });

    expect(await page.getByRole("heading", { name: "Connecting…" }).count()).toBe(1);
    expect(await page.getByRole("tab").allTextContents()).toEqual([
      "Now",
      "History",
      "Stats",
      "Privacy",
    ]);
    expect(await page.getByRole("button", { name: "Start recording" }).count()).toBe(1);

    await page.close();
  });

  it("takes over the served markup instead of drawing the page again", async () => {
    const { page, errors } = await openPage();

    await expect.poll(() => page.getByRole("heading", { name: "Couldn't start" }).count()).toBe(1);
    expect(await page.evaluate('window.served.main === document.querySelector("main")')).toBe(true);
    expect(await page.evaluate("window.served.tab === document.querySelector('[role=tab]')")).toBe(
      true,
    );
    expect(errors).toEqual([]);

    await page.close();
  });

  it("still starts when the page arrives without its rendered first screen", async () => {
    const rendered = await readFile(join(CLIENT, "index.html"), "utf8");
    const unrendered = rendered.replace(/<main[\s\S]*<\/main>/, '<div id="root"></div>');
    const page = await browser.newPage();
    const errors: Array<string> = [];

    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/**", (route) => {
      const answer = API.get(new URL(route.request().url()).pathname);

      return answer === undefined
        ? route.fulfill({ status: 404 })
        : route.fulfill({ status: 200, json: answer });
    });
    await page.route(/\/$/, (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: unrendered }),
    );
    await page.goto(`http://127.0.0.1:${portOf(server)}/`);

    expect(unrendered).not.toContain("data-foldkit-app");
    await expect.poll(() => page.getByRole("heading", { name: "Couldn't start" }).count()).toBe(1);
    expect(errors).toEqual([]);

    await page.close();
  });

  it("is styled, and moves between the tabs with the arrow keys", async () => {
    const { page } = await openPage();

    await page.getByRole("tab", { name: "Now" }).focus();
    await page.keyboard.press("ArrowRight");

    await expect
      .poll(() => page.getByRole("tab", { name: "History" }).getAttribute("aria-selected"))
      .toBe("true");
    expect(await page.evaluate("document.activeElement?.textContent")).toBe("History");
    expect(await page.evaluate("getComputedStyle(document.body).fontFamily")).toContain("Geist");

    await page.close();
  });
});
