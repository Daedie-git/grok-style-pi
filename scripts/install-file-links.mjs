#!/usr/bin/env node
import { installFileLinkHandler, fileLinkDesktopPath } from "../src/file-link-handler.ts";

if (process.platform !== "linux") throw new Error("File-link handler setup currently supports Linux only.");
installFileLinkHandler();
console.log(`Installed ${fileLinkDesktopPath()}. Run /reload in Pi to activate file links.`);
