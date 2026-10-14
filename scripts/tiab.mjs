#!/usr/bin/env node
// コンパイルと資格情報の読み込みは従来の入口と共有する。
import { launchCli } from './create-project.mjs';
process.exitCode = launchCli();
