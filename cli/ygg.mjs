#!/usr/bin/env node
import defaultFs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {runCheck, USAGE} from './check.mjs';
import {runIf} from './if.mjs';
import {runTrace} from './trace.mjs';
import {runFormat} from './format.mjs';
import {runPreview} from './preview.mjs';
import {runContext} from './context.mjs';
import {runTree} from './tree.mjs';
import {runStatus} from './status.mjs';
import {runInit} from './init.mjs';
import {runView} from './view.mjs';
import {runPack} from './pack.mjs';
import {runUnpack} from './unpack.mjs';

const SUBCOMMANDS = {view: runView, pack: runPack, unpack: runUnpack, if: runIf, trace: runTrace, preview: runPreview, context: runContext,
  tree: runTree, status: runStatus, init: runInit, format: runFormat};

export async function runCli(args, {cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr, fs, path: injectedPath} = {}) {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    stdout.write(USAGE);
    return 0;
  }
  if (args.length === 1 && (args[0] === '--version' || args[0] === '-v')) {
    const pkg = JSON.parse(await defaultFs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
    stdout.write(`yggdrasill ${pkg.version}\n`);
    return 0;
  }
  const context = {cwd, stdout, stderr, ...(fs ? {fs} : {}), ...(injectedPath ? {path: injectedPath} : {})};
  const command = SUBCOMMANDS[args[0]];
  if (command) return command(args.slice(1), context);
  return runCheck(args, context);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) process.exitCode = await runCli(process.argv.slice(2));
