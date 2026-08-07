const numericIdentifierPattern = /^(?:0|[1-9]\d*)$/;
const prereleaseIdentifierPattern = /^[0-9A-Za-z-]+$/;
const releaseVersionPattern = /^((?:0|[1-9]\d*))\.((?:0|[1-9]\d*))\.((?:0|[1-9]\d*))(?:-([0-9A-Za-z.-]+))?$/;

function parsedReleaseVersion(value) {
  if (typeof value !== "string") return null;
  const match = releaseVersionPattern.exec(value);
  if (!match) return null;
  const prerelease = match[4]?.split(".") ?? null;
  if (prerelease?.some((part) => !prereleaseIdentifierPattern.test(part) || (/^\d+$/.test(part) && !numericIdentifierPattern.test(part)))) {
    return null;
  }
  return { numbers: match.slice(1, 4), prerelease };
}

export function isReleaseVersion(value) {
  return parsedReleaseVersion(value) !== null;
}

function parseReleaseVersion(value) {
  const parsed = parsedReleaseVersion(value);
  if (!parsed) throw new Error(`Unsupported PorcuPi version identity: ${String(value)}`);
  return parsed;
}

function compareNumericIdentifiers(left, right) {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return left === right ? 0 : left < right ? -1 : 1;
}

export function compareReleaseVersions(left, right) {
  const a = parseReleaseVersion(left);
  const b = parseReleaseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    const comparison = compareNumericIdentifiers(a.numbers[index], b.numbers[index]);
    if (comparison !== 0) return comparison;
  }
  if (a.prerelease === null || b.prerelease === null) {
    return a.prerelease === b.prerelease ? 0 : a.prerelease === null ? 1 : -1;
  }
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === undefined || rightPart === undefined) return leftPart === undefined ? -1 : 1;
    if (leftPart === rightPart) continue;
    const leftIsNumeric = /^\d+$/.test(leftPart);
    const rightIsNumeric = /^\d+$/.test(rightPart);
    if (leftIsNumeric || rightIsNumeric) {
      if (!leftIsNumeric) return 1;
      if (!rightIsNumeric) return -1;
      return compareNumericIdentifiers(leftPart, rightPart);
    }
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

export function validateReleaseVersion(value) {
  compareReleaseVersions(value, value);
  return value;
}
