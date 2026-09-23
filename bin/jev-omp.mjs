#!/usr/bin/env node
// jev-omp: run Oh My Pi through a local jev-gateway. Nothing in ~/.omp is modified.
// The launcher keeps one background gateway per client and points only OMP's opencode-go
// provider at it; every other provider keeps talking to its own upstream directly.
import { omp } from "./clients.mjs";
import { runLauncher } from "./launcher.mjs";

await runLauncher(omp);
