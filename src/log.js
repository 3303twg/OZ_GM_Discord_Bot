import { formatLogTime } from "./format.js";

const methods = ["log", "info", "warn", "error"];
const original = Object.fromEntries(methods.map((method) => [method, console[method].bind(console)]));

for (const method of methods) {
  console[method] = (...args) => {
    original[method](`[${formatLogTime()}]`, ...args);
  };
}
