#!/usr/bin/env node
import sade from 'sade'
import pkg from './package.json' with { type: 'json' } // Already stable: https://nodejs.org/api/esm.html#json-modules
import * as mod from './index.js'

sade(pkg.name)
  .version(pkg.version)
  .describe('Explain installed packages')
  .example('esbuild')
  .example('semver@6')
  .command('explain', 'Explain installed packages', { default: true })
  .action(async function action(options) {
    let specs = options._
    if (specs.length === 0) {
      console.error(`Usage: ${pkg.name} <package-spec>`)
      process.exitCode = 1
      return
    }

    let result = await mod.explain(specs)
    let report = await mod.format(result)

    console.info(report)
  })
  .parse(process.argv)
