export type { LanguageDriver, LanguageId, MapOptions, MapResult, ComplexityOptions, DeadExportsOptions } from "./types.js";
export { PackageManifest } from "./types.js";
export { registerDriver, detectLanguage, getDriver, allDrivers } from "./registry.js";
export { goDriver } from "./go-driver.js";
export { tsDriver } from "./ts-driver.js";

// Register built-in drivers (Go first — go.mod is unambiguous)
import { registerDriver } from "./registry.js";
import { goDriver } from "./go-driver.js";
import { tsDriver } from "./ts-driver.js";

registerDriver(goDriver);
registerDriver(tsDriver);
