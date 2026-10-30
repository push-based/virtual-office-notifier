import { getTestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { afterEach } from "vitest";

getTestBed().initTestEnvironment(BrowserTestingModule, platformBrowserTesting());

afterEach(() => getTestBed().resetTestingModule());
