#!/usr/bin/env node
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {runCheck} from './check.mjs';
import {runIf} from './if.mjs';
import {runTrace} from './trace.mjs';
import {runFormat} from './format.mjs';
import {runPreview} from './preview.mjs';
import {runView} from './view.mjs';

const SUBCOMMANDS = {view: runView, if: runIf, trace: runTrace, preview: runPreview, format: runFormat};

export async function runCli(args, {cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr, fs, path: injectedPath} = {}) {
  const context = {cwd, stdout, stderr, ...(fs ? {fs} : {}), ...(injectedPath ? {path: injectedPath} : {})};
  const command = SUBCOMMANDS[args[0]];
  if (command) return command(args.slice(1), context);
  return runCheck(args, context);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) process.exitCode = await runCli(process.argv.slice(2));
