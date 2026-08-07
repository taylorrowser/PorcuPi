import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { defaultDataRoot, managedLayout } from "./runtime.mjs";
import {
  cachedReleaseStatus,
  checkReleaseAvailability,
  initialReleaseStatus,
  porcupiOffline,
  readReleaseStatusCache,
  releaseInstallCommand,
  releaseStatusColor,
  renderReleaseStatusRow,
  unavailableReleaseStatus,
} from "./release-status.mjs";

const widgetIdentity = "porcupi-release-status";
const renderGateIdentity = Symbol.for("porcupi.release-status.initial-render-gate");

function truncateRow(value, width) {
  if (!Number.isFinite(width) || width <= 0) return "";
  const characters = [...value];
  if (characters.length <= width) return value;
  if (width <= 3) return characters.slice(0, width).join("");
  return `${characters.slice(0, width - 3).join("")}...`;
}

function statusRow(status, width) {
  const full = renderReleaseStatusRow(status);
  if ([...full].length <= width || !status.targetVersion) return truncateRow(full, width);
  const command = releaseInstallCommand(status.targetVersion);
  const externalGuidance = `${command} (outside session)`;
  if ([...externalGuidance].length <= width) return externalGuidance;
  if ([...command].length <= width) return command;
  return truncateRow(command, width);
}

async function managedTuiClass() {
  const executable = process.env.PORCUPI_MANAGED_PI_EXECUTABLE;
  if (!executable) throw new Error("Managed Pi executable identity is unavailable to the TUI Integration");
  const modulePath = join(dirname(executable), "..", "..", "tui", "dist", "index.js");
  const module = await import(pathToFileURL(modulePath).href);
  if (typeof module.TUI?.prototype?.requestRender !== "function") {
    throw new Error("Managed Pi TUI render interface does not match the pinned Pi Base");
  }
  return module.TUI;
}

function preserveStatusRow(TUI) {
  const prototype = TUI.prototype;
  const existing = prototype[renderGateIdentity];
  if (existing) return existing;

  const original = prototype.requestRender;
  const gate = {
    component: undefined,
    container: undefined,
    released: false,
    tui: undefined,
    setComponent: undefined,
    release: undefined,
  };
  const guardedRequestRender = function guardedRequestRender(...args) {
    const isInteractiveManagedPi = this === gate.tui
      || (gate.tui === undefined && Array.isArray(this.children) && this.children.length >= 5);
    if (!gate.released && isInteractiveManagedPi) {
      if (!gate.component) return;
      if (!gate.container?.children?.includes(gate.component)) {
        const container = this.children.find((child) => Array.isArray(child.children) && child.children.includes(gate.component));
        if (container) {
          gate.container = container;
        } else if (typeof gate.container?.addChild === "function") {
          gate.container.addChild(gate.component);
        } else {
          return;
        }
      }
    }
    return original.apply(this, args);
  };
  gate.setComponent = (tui, component) => {
    gate.tui = tui;
    gate.component = component;
  };
  gate.release = () => {
    if (gate.released) return;
    gate.released = true;
    if (prototype.requestRender === guardedRequestRender) prototype.requestRender = original;
    if (prototype[renderGateIdentity] === gate) delete prototype[renderGateIdentity];
  };
  Object.defineProperty(prototype, renderGateIdentity, { configurable: true, value: gate });
  prototype.requestRender = guardedRequestRender;
  return gate;
}

export default async function porcupiTuiIntegration(pi) {
  const TUI = await managedTuiClass();
  const statusRowGuard = preserveStatusRow(TUI);
  let generation = 0;
  let controller;

  pi.on("session_start", (event, ctx) => {
    if (ctx.mode !== "tui") return;
    generation += 1;
    controller?.abort();
    const currentGeneration = generation;
    const installedVersion = process.env.PORCUPI_INSTALLED_VERSION;
    const paths = managedLayout(defaultDataRoot());
    let cache = null;
    let cacheIsTrusted = true;
    try {
      cache = readReleaseStatusCache(paths);
    } catch {
      cacheIsTrusted = false;
    }
    const offline = porcupiOffline();
    let status = !cacheIsTrusted
      ? unavailableReleaseStatus({ installedVersion, cache: null })
      : event.reason === "startup" || offline
        ? initialReleaseStatus({ installedVersion, cache, offline })
        : cachedReleaseStatus({ installedVersion, cache });
    let requestRender = () => {};

    ctx.ui.setWidget(widgetIdentity, (tui, theme) => {
      requestRender = () => tui.requestRender();
      const component = {
        render(width) {
          return [theme.fg(releaseStatusColor(status), statusRow(status, width))];
        },
        invalidate() {},
      };
      statusRowGuard.setComponent(tui, component);
      return component;
    });

    if (event.reason !== "startup" || offline || !cacheIsTrusted) return;
    controller = new AbortController();
    void checkReleaseAvailability({
      paths,
      installedVersion,
      endpoint: process.env.NODE_ENV === "test" ? process.env.PORCUPI_TEST_RELEASE_STATUS_URL : undefined,
      signal: controller.signal,
    }).then((result) => {
      if (generation !== currentGeneration) return;
      status = result;
      requestRender();
    }).catch(() => {
      if (generation !== currentGeneration || controller?.signal.aborted) return;
      status = unavailableReleaseStatus({ installedVersion, cache });
      requestRender();
    });
  });

  pi.on("session_shutdown", (event) => {
    generation += 1;
    controller?.abort();
    controller = undefined;
    if (event.reason === "quit") statusRowGuard.release();
  });
}
