import type { LanguageDriver, LanguageId } from "./types.js";

const drivers: LanguageDriver[] = [];

export function registerDriver(driver: LanguageDriver): void {
  if (drivers.some((d) => d.id === driver.id)) return;
  drivers.push(driver);
}

export async function detectLanguage(dir: string): Promise<LanguageDriver | null> {
  for (const driver of drivers) {
    if (await driver.detect(dir)) return driver;
  }
  return null;
}

export function getDriver(id: LanguageId): LanguageDriver | null {
  return drivers.find((d) => d.id === id) ?? null;
}

export function allDrivers(): readonly LanguageDriver[] {
  return drivers;
}
