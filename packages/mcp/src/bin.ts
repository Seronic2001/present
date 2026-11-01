#!/usr/bin/env node
import { serveMcp } from './server.ts';

await serveMcp(process.argv[2] ?? '.');
