#!/usr/bin/env node

import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { compositionRecipe } from "../src/composition.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const readJson = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));
const fail = (message) => { throw new Error(`PorcuPi package: ${message}`); };
const normalized = (path) => path.split(sep).join("/");
const safePath = (path) => typeof path === "string"
  && path.length > 0
  && !path.startsWith("/")
  && !path.includes("\\")
  && !path.split("/").some((part) => part === "" || part === "." || part === "..");

function regularFile(path) {
  try {
    const stat = lstatSync(join(root, path));
    return stat.isFile() && !stat.isSymbolicLink();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function walk(directory) {
  const files = [];
  function visit(path) {
    for (const name of readdirSync(path)) {
      const absolute = join(path, name);
      const stat = lstatSync(absolute);
      if (stat.isDirectory() && !stat.isSymbolicLink()) visit(absolute);
      else if (stat.isFile() && !stat.isSymbolicLink()) files.push(normalized(relative(root, absolute)));
      else fail(`unsupported package input: ${normalized(relative(root, absolute))}`);
    }
  }
  visit(resolve(root, directory));
  return files;
}

const manifest = readJson("package.json");
if (manifest.name !== "porcupi") fail(`package name must be porcupi, found ${String(manifest.name)}`);
if (manifest.private !== undefined) fail("public package must not set private");
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version || "")) fail("version must be exact semver");
if (JSON.stringify(manifest.bin) !== JSON.stringify({ porcupi: "scripts/install.mjs" })) fail("bin must expose only the one-shot porcupi installer");
if (!Array.isArray(manifest.files) || manifest.files.length === 0) fail("files must declare the packed inventory");

const declared = new Set();
for (const path of manifest.files) {
  if (!safePath(path) || declared.has(path)) fail(`invalid declared package input: ${String(path)}`);
  if (!path.startsWith("src/") && !path.startsWith("upstream/") && path !== "scripts/install.mjs" && !path.startsWith("release/")) {
    fail(`unsupported declared package input: ${path}`);
  }
  declared.add(path);
  if (!regularFile(path)) fail(`missing declared package input: ${path}`);
}

const releaseRecordPath = `release/v${manifest.version}.json`;
const declaredReleaseRecords = [...declared].filter((path) => path.startsWith("release/"));
if (JSON.stringify(declaredReleaseRecords) !== JSON.stringify([releaseRecordPath])) {
  fail(`package must carry only its exact release record: ${releaseRecordPath}`);
}
const releaseInputs = [...walk("src"), ...walk("upstream"), "scripts/install.mjs", releaseRecordPath];
for (const path of releaseInputs) {
  if (!declared.has(path)) fail(`undeclared package input: ${path}`);
}

const release = readJson(releaseRecordPath);
const lock = readJson("upstream/pi-base.json");
const packageLock = readJson("package-lock.json");
if (release.schemaVersion !== 1 || release.porcupiVersion !== manifest.version || release.tag !== `v${manifest.version}`) {
  fail("package version does not match its exact release record");
}
if (release.recipeId !== compositionRecipe.id) fail("release record does not match the fixed recipe");
if (JSON.stringify(release.piBase) !== JSON.stringify({ repository: lock.repository, tag: lock.tag, commit: lock.commit })) {
  fail("release record does not match the Pi Base lock");
}
if (
  packageLock.name !== manifest.name
  || packageLock.version !== manifest.version
  || packageLock.packages?.[""]?.name !== manifest.name
  || packageLock.packages?.[""]?.version !== manifest.version
) fail("package lock does not match package identity");
