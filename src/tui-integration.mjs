import { defaultDataRoot, managedLayout } from "./runtime.mjs";
import {
  cachedReleaseStatus,
  checkReleaseAvailability,
  initialReleaseStatus,
  porcupiOffline,
  readReleaseStatusCache,
  releaseStatusColor,
  renderReleaseStatusRow,
  unavailableReleaseStatus,
} from "./release-status.mjs";

const widgetIdentity = "porcupi-release-status";

function truncateRow(value, width) {
  if (!Number.isFinite(width) || width <= 0) return "";
  const characters = [...value];
  if (characters.length <= width) return value;
  if (width <= 3) return characters.slice(0, width).join("");
  return `${characters.slice(0, width - 3).join("")}...`;
}

export default function porcupiTuiIntegration(pi) {
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
      return {
        render(width) {
          const row = truncateRow(renderReleaseStatusRow(status), width);
          return [theme.fg(releaseStatusColor(status), row)];
        },
        invalidate() {},
      };
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

  pi.on("session_shutdown", () => {
    generation += 1;
    controller?.abort();
    controller = undefined;
  });
}
