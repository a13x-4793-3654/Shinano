import { _electron, expect, test as base, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserState, Command, Tab } from '../../src/shared/model.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));

export class Harness {
  private application: ElectronApplication | undefined;
  private chrome: Page | undefined;

  constructor(readonly userData: string) {}

  get app(): ElectronApplication {
    if (!this.application) throw new Error('Fixture application is not running.');
    return this.application;
  }

  get page(): Page {
    if (!this.chrome) throw new Error('Fixture chrome is not ready.');
    return this.chrome;
  }

  async start(): Promise<void> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.SHINANO_DEV_URL;
    env.SHINANO_USER_DATA_DIR = this.userData;
    const executablePath = process.env.SHINANO_TEST_EXECUTABLE;
    this.application = await _electron.launch(executablePath
      ? { executablePath, args: [], env }
      : { args: [root], env });
    // Restored remote views can attach to Playwright before the trusted chrome.
    await expect.poll(() => this.app.context().pages().some((page) => page.url() === 'shinano://app/')).toBe(true);
    this.chrome = this.app.context().pages().find((page) => page.url() === 'shinano://app/');
    await expect.poll(async () => (await this.state()).profiles.length).toBeGreaterThanOrEqual(0);
  }

  async stop(): Promise<void> {
    const application = this.application;
    this.application = undefined;
    this.chrome = undefined;
    if (!application) return;
    const child = application.process();
    if (child.exitCode !== null) return;
    try {
      // Automate only the OS dialog decision; the real app flushes its real sessions.
      await application.evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
      });
      await application.close();
    } finally {
      if (child.exitCode === null) child.kill('SIGTERM');
    }
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  async state(): Promise<BrowserState> {
    return this.page.evaluate(async () => {
      const result = await window.shinano.getState();
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });
  }

  async command(command: Command): Promise<BrowserState> {
    return this.page.evaluate(async (value) => {
      const result = await window.shinano.dispatch(value);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    }, command);
  }

  async createTab(profileId: string, url: string): Promise<Tab> {
    const prior = new Set((await this.state()).tabs.map((tab) => tab.id));
    const result = await this.command({ type: 'tab:create', profileId, url });
    const created = result.tabs.find((tab) => !prior.has(tab.id));
    if (!created) throw new Error('Fixture tab creation failed.');
    await this.waitForTab(created.id);
    return created;
  }

  async waitForTab(tabId: string): Promise<void> {
    await expect.poll(async () => {
      const tab = (await this.state()).tabs.find((entry) => entry.id === tabId);
      return Boolean(tab && !tab.loading && (tab.isStartPage || tab.title.startsWith('Fixture') || tab.title.startsWith('Restored')));
    }).toBe(true);
  }

  async remote<T>(url: string, source: string): Promise<T> {
    if (!url.startsWith('http://127.0.0.1:')) throw new Error('Tests may only inspect a local fixture.');
    return this.app.evaluate(async ({ webContents }, args) => {
      const contents = webContents.getAllWebContents().find((entry) => entry.getURL() === args.url);
      if (!contents) throw new Error('Local fixture WebContents not found.');
      return contents.executeJavaScript(args.source, true);
    }, { url, source });
  }

  async dialogChoice(response: number): Promise<void> {
    await this.app.evaluate(({ dialog }, choice) => {
      dialog.showMessageBox = async () => ({ response: choice, checkboxChecked: false });
    }, response);
  }
}

export const test = base.extend<{ shinano: Harness }>({
  shinano: async ({}, use) => {
    const directory = await mkdtemp(join(tmpdir(), 'shinano-e2e-'));
    const harness = new Harness(directory);
    try {
      await harness.start();
      await use(harness);
    } finally {
      try {
        await harness.stop();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  },
});

export { expect };
