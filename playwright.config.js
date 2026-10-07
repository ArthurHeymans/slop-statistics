import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir:'test/browser', workers:1, fullyParallel:false, timeout:30000,
  use:{browserName:'chromium',headless:true,launchOptions:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{}},
  reporter:'list'
});
