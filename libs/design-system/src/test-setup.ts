import { getTestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { afterEach } from "vite-plus/test";

getTestBed().initTestEnvironment(BrowserTestingModule, platformBrowserTesting());

afterEach(() => getTestBed().resetTestingModule());
