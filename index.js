import fs from 'node:fs/promises'
import tty from 'node:tty'
import validate from 'validate-npm-package-name'
import * as jsonc from './lib/jsonc.js'
import satisfies from 'semver/functions/satisfies.js'

/**
 * @typedef {object} Why
 * @property {string} name The name of the package.
 * @property {string} version The version of the package.
 * @property {string} location The key in the lockfile's `packages` object.
 * @property {Why[]} [dependents] The list of packages that depend on this package.
 */

/**
 * @typedef {object} BunLockfile
 * @property {{
 *   [location: string]: [
 *     name_version: string,
 *     tarball_if_not_default_registry: string,
 *     package: {
 *       dependencies?: Record<string, string>,
 *       optionalDependencies?: Record<string, string>,
 *     },
 *     integrity?: string,
 *   ]
 * }} packages
 */

/**
 * Search packages from the lockfile `bun.lock`.
 * @param {string[]} specs List of package specs to match against entries in the lockfile.
 * @returns {Promise<Why[]>}
 */
export async function explain(specs) {
  let [packages, dependents] = await readLockfile()
  let entryPoints = collectLocationsFromSpecs(packages, specs)
  return Array.from(entryPoints, location => makeWhy(location, packages, dependents)).filter(x => !!x)
}

/**
 * @param {string} location The key in the lockfile's `packages` object.
 * @param {BunLockfile['packages']} packages All packages from the lockfile.
 * @param {Record<string, string[]>} dependents If A depends on B, then { B: [A] }.
 * @returns {Why | undefined}
 */
function makeWhy(location, packages, dependents) {
  let [id] = packages[location]
  let i = id.indexOf('@', 1)
  if (i <= 0)
    return

  let name = id.slice(0, i)
  let version = id.slice(i + 1)

  /** @type {Why} */
  let why = {
    name,
    version,
    location,
    dependents: dependents[location]?.map(loc => makeWhy(loc, packages, dependents)) || []
  }

  return why
}

function collectLocationsFromSpecs(packages, specs) {
  /** @type {Set<string>} */
  let collected = new Set()

  /** @param {string} name */
  function byPackageName(name) {
    if (Object.hasOwn(packages, name)) {
      collected.add(name)
    }
    let suffix = '/' + name
    for (let location in packages) {
      if (location.endsWith(suffix)) {
        let id = packages[location][0]
        let i = id.indexOf('@', 1)
        if (id.slice(0, i) === name) {
          collected.add(location)
        }
      }
    }
  }

  /** @param {string} location */
  function byLocation(location) {
    if (Object.hasOwn(packages, location)) {
      collected.add(location)
    }
  }

  /**
   * @param {string} name
   * @param {string} range
   */
  function bySpec(name, range) {
    if (range === '*') {
      byPackageName(name)
      return
    }

    for (let location in packages) {
      let [id] = packages[location]
      let i = id.indexOf('@', 1)
      if (i > 0 && id.slice(0, i) === name) {
        let version = id.slice(i + 1)
        if (satisfies(version, range)) {
          collected.add(location)
        }
      }
    }
  }

  for (let spec of specs) {
    if (validate(spec).validForOldPackages) {
      byPackageName(spec)
      continue
    }

    let maybeLoc = spec.replace(/\\/g, '/').replace(/\/node_modules\//g, '/')
    if (packages[maybeLoc]) {
      byLocation(maybeLoc)
      continue
    }

    let i = spec.indexOf('@', 1)
    if (i > 0) {
      bySpec(spec.slice(0, i), spec.slice(i + 1) || '*')
    } else {
      throw new Error(`Invalid package spec: ${spec}, expected "name@range" or "name"`)
    }
  }

  return collected
}

/**
 * @returns {Promise<[BunLockfile['packages'], dependents: Record<string, string[]>]>}
 */
async function readLockfile() {
  /** @type {BunLockfile} */
  let lockfile = await fs.readFile('bun.lock', 'utf8').then(jsonc.parse)

  /** @type {Record<string, string[]>} */
  let dependents = { __proto__: null }

  for (let location in lockfile.packages) {
    function scanDeps(dependencies) {
      if (dependencies) for (let depName in dependencies) {
        let range = dependencies[depName]
        for (let maybeLoc of iterateLocations(location, depName)) {
          let info = lockfile.packages[maybeLoc]
          if (info) {
            let i = info[0].indexOf('@', 1)
            if (i > 0) {
              let depVersion = info[0].slice(i + 1)
              if (satisfies(depVersion, range)) {
                dependents[maybeLoc] ??= []
                dependents[maybeLoc].push(location)
                break
              }
            }
          }
        }
      }
    }

    let [, , pkg] = lockfile.packages[location]
    scanDeps(pkg.dependencies)
    scanDeps(pkg.optionalDependencies)
  }

  return [lockfile.packages, dependents]
}

/**
 * @param {string} dir
 * @param {string} name
 */
function* iterateLocations(dir, name) {
  /** @type {string[]} */
  let parts = [], raw = dir.split('/')
  for (let i = 0; i < raw.length; i++) {
    let part = raw[i]
    if (part[0] == '@') {
      parts.push(part + '/' + raw[++i])
    } else {
      parts.push(part)
    }
  }

  for (let i = parts.length; i > 0; i--) {
    yield parts.slice(0, i).join('/') + '/' + name
  }
  yield name
}

/**
 * Pretty-print the result of {@link explain}, there's no new-line at the end.
 * @param {Why[] | undefined} result The return value of {@link explain}.
 * @returns {Promise<string>}
 */
export async function format(result) {
  if (!result || result.length === 0)
    return ''

  /** @type {string[]} */
  let lines = []
  let [packages] = await readLockfile()
  for (const why of result) {
    format1(lines, packages, why, 0)
  }

  return lines.slice(1).join('\n')
}

const dim = /*#__PURE__*/ (() => tty?.WriteStream?.prototype?.hasColors?.()
  ? (str) => `\x1b[2m${str}\x1b[22m`
  : (str) => str
)()

/**
 * @param {string[]} out Output, make sure to start with an empty string ''.
 * @param {BunLockfile['packages']} packages
 * @param {Why} why
 * @param {number} depth
 * @param {Why} [dependency] The package that depends on `why`.
 */
function format1(out, packages, why, depth, dependency) {
  let indent = '  '.repeat(depth)
  if (depth && dependency) {
    let range = rangeOf(packages[why.location], dependency.name, dependency.version) || '*'
    out.push(`${indent}${dependency.name}@${range} from ${why.name}@${why.version}`)
  } else {
    out.push('')
    out.push(`${indent}${why.name}@${why.version}`)
  }
  out.push(`${indent}${dim(expandLocation(why.location))}`)
  if (why.dependents.length > 0) {
    for (let dep of why.dependents) {
      format1(out, packages, dep, depth + 1, why)
    }
  }
}

function rangeOf(info, name, version) {
  /** @type {BunLockfile['packages'][string][2]} */
  let pkg = info[2]
  if (pkg.dependencies) for (let dep in pkg.dependencies) {
    if (dep === name && satisfies(version, pkg.dependencies[dep])) {
      return pkg.dependencies[dep]
    }
  }
  if (pkg.optionalDependencies) for (let dep in pkg.optionalDependencies) {
    if (dep === name && satisfies(version, pkg.optionalDependencies[dep])) {
      return pkg.optionalDependencies[dep]
    }
  }
}

function expandLocation(location) {
  let parts = location.split('/'), out = ''
  for (let i = 0; i < parts.length; i++) {
    let part = parts[i]
    if (part[0] === '@') {
      out += '/node_modules/' + part + '/' + parts[++i]
    } else {
      out += '/node_modules/' + part
    }
  }
  return out.slice(1)
}

export { explain as why, explain as default }
