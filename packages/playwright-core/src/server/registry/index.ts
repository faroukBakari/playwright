/**
 * Copyright 2017 Google Inc. All rights reserved.
 * Modifications copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import * as util from 'util';

import { downloadBrowserWithProgressBar, logPolitely } from './browserFetcher';
import { dockerVersion, readDockerVersionSync, transformCommandsForRoot } from './dependencies';
import { installDependenciesLinux, installDependenciesWindows, validateDependenciesLinux, validateDependenciesWindows } from './dependencies';
import { calculateSha1, getAsBooleanFromENV, getFromENV, getPackageManagerExecCommand } from '../../utils';
import { wrapInASCIIBox } from '../utils/ascii';
import { debugLogger } from '../utils/debugLogger';
import { shortPlatform, hostPlatform, isOfficiallySupportedPlatform } from '../utils/hostPlatform';
import { fetchData, NET_DEFAULT_TIMEOUT } from '../utils/network';
import { spawnAsync } from '../utils/spawnAsync';
import { getEmbedderName } from '../utils/userAgent';
import { lockfile } from '../../utilsBundle';
import { canAccessFile, existsAsync, removeFolders } from '../utils/fileUtils';

import type { DependencyGroup } from './dependencies';
import type { HostPlatform } from '../utils/hostPlatform';

export { writeDockerVersion } from './dependencies';

const PACKAGE_PATH = path.join(__dirname, '..', '..', '..');
const BIN_PATH = path.join(__dirname, '..', '..', '..', 'bin');

const PLAYWRIGHT_CDN_MIRRORS = [
  'https://cdn.playwright.dev/dbazure/download/playwright', // ESRP CDN
  'https://playwright.download.prss.microsoft.com/dbazure/download/playwright', // Directly hit ESRP CDN
  'https://cdn.playwright.dev', // Hit the Storage Bucket directly
];

if (process.env.PW_TEST_CDN_THAT_SHOULD_WORK) {
  for (let i = 0; i < PLAYWRIGHT_CDN_MIRRORS.length; i++) {
    const cdn = PLAYWRIGHT_CDN_MIRRORS[i];
    if (cdn !== process.env.PW_TEST_CDN_THAT_SHOULD_WORK) {
      const parsedCDN = new URL(cdn);
      parsedCDN.hostname = parsedCDN.hostname + '.does-not-resolve.playwright.dev';
      PLAYWRIGHT_CDN_MIRRORS[i] = parsedCDN.toString();
    }
  }
}

const EXECUTABLE_PATHS = {
  'chromium': {
    '<unknown>': undefined,
    'linux-x64': ['chrome-linux64', 'chrome'],
    'linux-arm64': ['chrome-linux', 'chrome'],  // non-cft build
    'mac-x64': ['chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'],
    'mac-arm64': ['chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'],
    'win-x64': ['chrome-win64', 'chrome.exe'],
  },
  'chromium-headless-shell': {
    '<unknown>': undefined,
    'linux-x64': ['chrome-headless-shell-linux64', 'chrome-headless-shell'],
    'linux-arm64': ['chrome-linux', 'headless_shell'],  // non-cft build
    'mac-x64': ['chrome-headless-shell-mac-x64', 'chrome-headless-shell'],
    'mac-arm64': ['chrome-headless-shell-mac-arm64', 'chrome-headless-shell'],
    'win-x64': ['chrome-headless-shell-win64', 'chrome-headless-shell.exe'],
  },
};

type DownloadPathFunction = (params: BrowsersJSONDescriptor) => { path: string, mirrors: string[] };

function cftUrl(suffix: string): DownloadPathFunction {
  return ({ browserVersion }) => {
    return {
      path: `builds/cft/${browserVersion}/${suffix}`,
      mirrors: [
        'https://cdn.playwright.dev',
      ],
    };
  };
}

type DownloadPaths = Record<HostPlatform, string | DownloadPathFunction | undefined>;
const DOWNLOAD_PATHS: Record<string, DownloadPaths> = {
  'chromium': {
    '<unknown>': undefined,
    'ubuntu18.04-x64': undefined,
    'ubuntu20.04-x64': cftUrl('linux64/chrome-linux64.zip'),
    'ubuntu22.04-x64': cftUrl('linux64/chrome-linux64.zip'),
    'ubuntu24.04-x64': cftUrl('linux64/chrome-linux64.zip'),
    'ubuntu18.04-arm64': undefined,
    'ubuntu20.04-arm64': 'builds/chromium/%s/chromium-linux-arm64.zip',
    'ubuntu22.04-arm64': 'builds/chromium/%s/chromium-linux-arm64.zip',
    'ubuntu24.04-arm64': 'builds/chromium/%s/chromium-linux-arm64.zip',
    'debian11-x64': cftUrl('linux64/chrome-linux64.zip'),
    'debian11-arm64': 'builds/chromium/%s/chromium-linux-arm64.zip',
    'debian12-x64': cftUrl('linux64/chrome-linux64.zip'),
    'debian12-arm64': 'builds/chromium/%s/chromium-linux-arm64.zip',
    'debian13-x64': cftUrl('linux64/chrome-linux64.zip'),
    'debian13-arm64': 'builds/chromium/%s/chromium-linux-arm64.zip',
    'mac10.13': cftUrl('mac-x64/chrome-mac-x64.zip'),
    'mac10.14': cftUrl('mac-x64/chrome-mac-x64.zip'),
    'mac10.15': cftUrl('mac-x64/chrome-mac-x64.zip'),
    'mac11': cftUrl('mac-x64/chrome-mac-x64.zip'),
    'mac11-arm64': cftUrl('mac-arm64/chrome-mac-arm64.zip'),
    'mac12': cftUrl('mac-x64/chrome-mac-x64.zip'),
    'mac12-arm64': cftUrl('mac-arm64/chrome-mac-arm64.zip'),
    'mac13': cftUrl('mac-x64/chrome-mac-x64.zip'),
    'mac13-arm64': cftUrl('mac-arm64/chrome-mac-arm64.zip'),
    'mac14': cftUrl('mac-x64/chrome-mac-x64.zip'),
    'mac14-arm64': cftUrl('mac-arm64/chrome-mac-arm64.zip'),
    'mac15': cftUrl('mac-x64/chrome-mac-x64.zip'),
    'mac15-arm64': cftUrl('mac-arm64/chrome-mac-arm64.zip'),
    'win64': cftUrl('win64/chrome-win64.zip'),
  },
  'chromium-headless-shell': {
    '<unknown>': undefined,
    'ubuntu18.04-x64': undefined,
    'ubuntu20.04-x64': cftUrl('linux64/chrome-headless-shell-linux64.zip'),
    'ubuntu22.04-x64': cftUrl('linux64/chrome-headless-shell-linux64.zip'),
    'ubuntu24.04-x64': cftUrl('linux64/chrome-headless-shell-linux64.zip'),
    'ubuntu18.04-arm64': undefined,
    'ubuntu20.04-arm64': 'builds/chromium/%s/chromium-headless-shell-linux-arm64.zip',
    'ubuntu22.04-arm64': 'builds/chromium/%s/chromium-headless-shell-linux-arm64.zip',
    'ubuntu24.04-arm64': 'builds/chromium/%s/chromium-headless-shell-linux-arm64.zip',
    'debian11-x64': cftUrl('linux64/chrome-headless-shell-linux64.zip'),
    'debian11-arm64': 'builds/chromium/%s/chromium-headless-shell-linux-arm64.zip',
    'debian12-x64': cftUrl('linux64/chrome-headless-shell-linux64.zip'),
    'debian12-arm64': 'builds/chromium/%s/chromium-headless-shell-linux-arm64.zip',
    'debian13-x64': cftUrl('linux64/chrome-headless-shell-linux64.zip'),
    'debian13-arm64': 'builds/chromium/%s/chromium-headless-shell-linux-arm64.zip',
    'mac10.13': undefined,
    'mac10.14': undefined,
    'mac10.15': undefined,
    'mac11': cftUrl('mac-x64/chrome-headless-shell-mac-x64.zip'),
    'mac11-arm64': cftUrl('mac-arm64/chrome-headless-shell-mac-arm64.zip'),
    'mac12': cftUrl('mac-x64/chrome-headless-shell-mac-x64.zip'),
    'mac12-arm64': cftUrl('mac-arm64/chrome-headless-shell-mac-arm64.zip'),
    'mac13': cftUrl('mac-x64/chrome-headless-shell-mac-x64.zip'),
    'mac13-arm64': cftUrl('mac-arm64/chrome-headless-shell-mac-arm64.zip'),
    'mac14': cftUrl('mac-x64/chrome-headless-shell-mac-x64.zip'),
    'mac14-arm64': cftUrl('mac-arm64/chrome-headless-shell-mac-arm64.zip'),
    'mac15': cftUrl('mac-x64/chrome-headless-shell-mac-x64.zip'),
    'mac15-arm64': cftUrl('mac-arm64/chrome-headless-shell-mac-arm64.zip'),
    'win64': cftUrl('win64/chrome-headless-shell-win64.zip'),
  },
};

export const defaultCacheDirectory = (() => {
  if (process.platform === 'linux')
    return process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  if (process.platform === 'darwin')
    return path.join(os.homedir(), 'Library', 'Caches');
  if (process.platform === 'win32')
    return process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  throw new Error('Unsupported platform: ' + process.platform);
})();

export const defaultRegistryDirectory = path.join(defaultCacheDirectory, 'ms-playwright');

export const registryDirectory = (() => {
  let result: string;

  const envDefined = getFromENV('PLAYWRIGHT_BROWSERS_PATH');
  if (envDefined === '0')
    result = path.join(__dirname, '..', '..', '..', '.local-browsers');
  else if (envDefined)
    result = envDefined;
  else
    result = defaultRegistryDirectory;

  if (!path.isAbsolute(result)) {
    // It is important to resolve to the absolute path:
    //   - for unzipping to work correctly;
    //   - so that registry directory matches between installation and execution.
    // INIT_CWD points to the root of `npm/yarn install` and is probably what
    // the user meant when typing the relative path.
    result = path.resolve(getFromENV('INIT_CWD') || process.cwd(), result);
  }
  return result;
})();

function isBrowserDirectory(browserDirectory: string): boolean {
  const baseName = path.basename(browserDirectory);
  for (const browserName of allDownloadableDirectoriesThatEverExisted) {
    if (baseName.startsWith(browserName.replace(/-/g, '_') + '-'))
      return true;
  }
  return false;
}

type BrowsersJSON = {
  comment: string
  browsers: {
    name: string,
    revision: string,
    browserVersion?: string,
    title?: string,
    installByDefault: boolean,
    revisionOverrides?: {[os: string]: string},
  }[]
};

type BrowsersJSONDescriptor = {
  name: string,
  revision: string,
  hasRevisionOverride: boolean
  browserVersion?: string,
  title?: string,
  installByDefault: boolean,
  dir: string,
};

export type BrowserInfo = {
  browserName: string,
  browserVersion: number,
  browserPath: string
  referenceDir: string,
};

function readDescriptors(browsersJSON: BrowsersJSON): BrowsersJSONDescriptor[] {
  return (browsersJSON['browsers']).map(obj => {
    const name = obj.name;
    const revisionOverride = (obj.revisionOverrides || {})[hostPlatform];
    const revision = revisionOverride || obj.revision;
    const browserDirectoryPrefix = revisionOverride ? `${name}_${hostPlatform}_special` : `${name}`;
    const descriptor: BrowsersJSONDescriptor = {
      name,
      revision,
      hasRevisionOverride: !!revisionOverride,
      // We only put browser version for the supported operating systems.
      browserVersion: revisionOverride ? undefined : obj.browserVersion,
      title: obj['title'],
      installByDefault: !!obj.installByDefault,
      // Method `isBrowserDirectory` determines directory to be browser iff
      // it starts with some browser name followed by '-'. Some browser names
      // are prefixes of others, e.g. 'webkit' is a prefix of `webkit-technology-preview`.
      // To avoid older registries erroneously removing 'webkit-technology-preview', we have to
      // ensure that browser folders to never include dashes inside.
      dir: path.join(registryDirectory, browserDirectoryPrefix.replace(/-/g, '_') + '-' + revision),
    };
    return descriptor;
  });
}

export type BrowserName = 'chromium';
const allDownloadableDirectoriesThatEverExisted = ['android', 'chromium', 'firefox', 'webkit', 'ffmpeg', 'firefox-beta', 'chromium-tip-of-tree', 'chromium-headless-shell', 'chromium-tip-of-tree-headless-shell', 'winldd'];
const chromiumAliases = ['chrome-for-testing'];

export interface Executable {
  name: string;
  browserName: BrowserName | undefined;
  installType: 'download-by-default' | 'download-on-demand' | 'install-script' | 'none';
  directory: string | undefined;
  downloadURLs?: string[],
  title?: string,
  revision?: string,
  browserVersion?: string,
  executablePathOrDie(sdkLanguage: string): string;
  executablePath(): string | undefined;
  _validateHostRequirements(sdkLanguage: string): Promise<void>;
  wslExecutablePath?: string
}

interface ExecutableImpl extends Executable {
  _install?: (force: boolean) => Promise<void>;
  _dependencyGroup?: DependencyGroup;
  _isHermeticInstallation?: boolean;
}

export class Registry {
  private _executables: ExecutableImpl[];

  constructor(browsersJSON: BrowsersJSON) {
    const descriptors = readDescriptors(browsersJSON);
    const findExecutablePath = (dir: string, name: keyof typeof EXECUTABLE_PATHS) => {
      const tokens = EXECUTABLE_PATHS[name][shortPlatform];
      return tokens ? path.join(dir, ...tokens) : undefined;
    };
    const executablePathOrDie = (name: string, e: string | undefined, installByDefault: boolean, sdkLanguage: string) => {
      if (!e)
        throw new Error(`${name} is not supported on ${hostPlatform}`);
      const installCommand = buildPlaywrightCLICommand(sdkLanguage, `install${installByDefault ? '' : ' ' + name}`);
      if (!canAccessFile(e)) {
        const currentDockerVersion = readDockerVersionSync();
        const preferredDockerVersion = currentDockerVersion ? dockerVersion(currentDockerVersion.dockerImageNameTemplate) : null;
        const isOutdatedDockerImage = currentDockerVersion && preferredDockerVersion && currentDockerVersion.dockerImageName !== preferredDockerVersion.dockerImageName;
        let prettyMessage;
        if (isOutdatedDockerImage) {
          prettyMessage = [
            `Looks like Playwright was just updated to ${preferredDockerVersion.driverVersion}.`,
            `Please update docker image as well.`,
            `-  current: ${currentDockerVersion.dockerImageName}`,
            `- required: ${preferredDockerVersion.dockerImageName}`,
            ``,
            `<3 Playwright Team`,
          ].join('\n');
        } else {
          prettyMessage = [
            `Looks like Playwright was just installed or updated.`,
            `Please run the following command to download new browser${installByDefault ? 's' : ''}:`,
            ``,
            `    ${installCommand}`,
            ``,
            `<3 Playwright Team`,
          ].join('\n');
        }
        throw new Error(`Executable doesn't exist at ${e}\n${wrapInASCIIBox(prettyMessage, 1)}`);
      }
      return e;
    };
    this._executables = [];

    const chromium = descriptors.find(d => d.name === 'chromium')!;
    const chromiumExecutable = findExecutablePath(chromium.dir, 'chromium');
    this._executables.push({
      name: 'chromium',
      browserName: 'chromium',
      directory: chromium.dir,
      executablePath: () => chromiumExecutable,
      executablePathOrDie: (sdkLanguage: string) => executablePathOrDie('chromium', chromiumExecutable, chromium.installByDefault, sdkLanguage),
      installType: chromium.installByDefault ? 'download-by-default' : 'download-on-demand',
      _validateHostRequirements: (sdkLanguage: string) => this._validateHostRequirements(sdkLanguage, chromium.dir, ['chrome-linux'], [], ['chrome-win']),
      downloadURLs: this._downloadURLs(chromium),
      title: chromium.title,
      revision: chromium.revision,
      browserVersion: chromium.browserVersion,
      _install: force => this._downloadExecutable(chromium, force, chromiumExecutable),
      _dependencyGroup: 'chromium',
      _isHermeticInstallation: true,
    });

    const chromiumHeadlessShell = descriptors.find(d => d.name === 'chromium-headless-shell')!;
    const chromiumHeadlessShellExecutable = findExecutablePath(chromiumHeadlessShell.dir, 'chromium-headless-shell');
    this._executables.push({
      name: 'chromium-headless-shell',
      browserName: 'chromium',
      directory: chromiumHeadlessShell.dir,
      executablePath: () => chromiumHeadlessShellExecutable,
      executablePathOrDie: (sdkLanguage: string) => executablePathOrDie('chromium', chromiumHeadlessShellExecutable, chromiumHeadlessShell.installByDefault, sdkLanguage),
      installType: chromiumHeadlessShell.installByDefault ? 'download-by-default' : 'download-on-demand',
      _validateHostRequirements: (sdkLanguage: string) => this._validateHostRequirements(sdkLanguage, chromiumHeadlessShell.dir, ['chrome-linux'], [], ['chrome-win']),
      downloadURLs: this._downloadURLs(chromiumHeadlessShell),
      title: chromiumHeadlessShell.title,
      revision: chromiumHeadlessShell.revision,
      browserVersion: chromiumHeadlessShell.browserVersion,
      _install: force => this._downloadExecutable(chromiumHeadlessShell, force, chromiumHeadlessShellExecutable),
      _dependencyGroup: 'chromium',
      _isHermeticInstallation: true,
    });

    this._executables.push(this._createChromiumChannel('chrome', {
      'linux': '/opt/google/chrome/chrome',
      'darwin': '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      'win32': `\\Google\\Chrome\\Application\\chrome.exe`,
    }, () => this._installChromiumChannel('chrome', {
      'linux': 'reinstall_chrome_stable_linux.sh',
      'darwin': 'reinstall_chrome_stable_mac.sh',
      'win32': 'reinstall_chrome_stable_win.ps1',
    })));

    this._executables.push(this._createChromiumChannel('chrome-beta', {
      'linux': '/opt/google/chrome-beta/chrome',
      'darwin': '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
      'win32': `\\Google\\Chrome Beta\\Application\\chrome.exe`,
    }, () => this._installChromiumChannel('chrome-beta', {
      'linux': 'reinstall_chrome_beta_linux.sh',
      'darwin': 'reinstall_chrome_beta_mac.sh',
      'win32': 'reinstall_chrome_beta_win.ps1',
    })));

    this._executables.push(this._createChromiumChannel('chrome-dev', {
      'linux': '/opt/google/chrome-unstable/chrome',
      'darwin': '/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev',
      'win32': `\\Google\\Chrome Dev\\Application\\chrome.exe`,
    }));

    this._executables.push(this._createChromiumChannel('chrome-canary', {
      'linux': '/opt/google/chrome-canary/chrome',
      'darwin': '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      'win32': `\\Google\\Chrome SxS\\Application\\chrome.exe`,
    }));

    this._executables.push(this._createChromiumChannel('msedge', {
      'linux': '/opt/microsoft/msedge/msedge',
      'darwin': '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      'win32': `\\Microsoft\\Edge\\Application\\msedge.exe`,
    }, () => this._installMSEdgeChannel('msedge', {
      'linux': 'reinstall_msedge_stable_linux.sh',
      'darwin': 'reinstall_msedge_stable_mac.sh',
      'win32': 'reinstall_msedge_stable_win.ps1',
    })));

    this._executables.push(this._createChromiumChannel('msedge-beta', {
      'linux': '/opt/microsoft/msedge-beta/msedge',
      'darwin': '/Applications/Microsoft Edge Beta.app/Contents/MacOS/Microsoft Edge Beta',
      'win32': `\\Microsoft\\Edge Beta\\Application\\msedge.exe`,
    }, () => this._installMSEdgeChannel('msedge-beta', {
      'darwin': 'reinstall_msedge_beta_mac.sh',
      'linux': 'reinstall_msedge_beta_linux.sh',
      'win32': 'reinstall_msedge_beta_win.ps1',
    })));

    this._executables.push(this._createChromiumChannel('msedge-dev', {
      'linux': '/opt/microsoft/msedge-dev/msedge',
      'darwin': '/Applications/Microsoft Edge Dev.app/Contents/MacOS/Microsoft Edge Dev',
      'win32': `\\Microsoft\\Edge Dev\\Application\\msedge.exe`,
    }, () => this._installMSEdgeChannel('msedge-dev', {
      'darwin': 'reinstall_msedge_dev_mac.sh',
      'linux': 'reinstall_msedge_dev_linux.sh',
      'win32': 'reinstall_msedge_dev_win.ps1',
    })));

    this._executables.push(this._createChromiumChannel('msedge-canary', {
      'linux': '',
      'darwin': '/Applications/Microsoft Edge Canary.app/Contents/MacOS/Microsoft Edge Canary',
      'win32': `\\Microsoft\\Edge SxS\\Application\\msedge.exe`,
    }));

  }

  private _createChromiumChannel(name: string, lookAt: Record<'linux' | 'darwin' | 'win32', string>, install?: () => Promise<void>): ExecutableImpl {
    const executablePath = (sdkLanguage: string, shouldThrow: boolean) => {
      const suffix = lookAt[process.platform as 'linux' | 'darwin' | 'win32'];
      if (!suffix) {
        if (shouldThrow)
          throw new Error(`Chromium distribution '${name}' is not supported on ${process.platform}`);
        return undefined;
      }
      const prefixes = (process.platform === 'win32' ? [
        process.env.LOCALAPPDATA,
        process.env.PROGRAMFILES,
        process.env['PROGRAMFILES(X86)'],
        // In some cases there is no PROGRAMFILES/(86) env var set but HOMEDRIVE is set.
        process.env.HOMEDRIVE + '\\Program Files',
        process.env.HOMEDRIVE + '\\Program Files (x86)',
      ].filter(Boolean) : ['']) as string[];

      for (const prefix of prefixes) {
        const executablePath = path.join(prefix, suffix);
        if (canAccessFile(executablePath))
          return executablePath;
      }
      if (!shouldThrow)
        return undefined;

      const location = prefixes.length ? ` at ${path.join(prefixes[0], suffix)}` : ``;
      const installation = install ? `\nRun "${buildPlaywrightCLICommand(sdkLanguage, 'install ' + name)}"` : '';
      throw new Error(`Chromium distribution '${name}' is not found${location}${installation}`);
    };
    return {
      name,
      browserName: 'chromium',
      directory: undefined,
      executablePath: () => executablePath('', false),
      executablePathOrDie: (sdkLanguage: string) => executablePath(sdkLanguage, true)!,
      installType: install ? 'install-script' : 'none',
      _validateHostRequirements: () => Promise.resolve(),
      _isHermeticInstallation: false,
      _install: install,
    };
  }

  executables(): Executable[] {
    return this._executables;
  }

  findExecutable(name: BrowserName): Executable;
  findExecutable(name: string): Executable | undefined;
  findExecutable(name: string): Executable | undefined {
    return this._executables.find(b => b.name === name);
  }

  defaultExecutables(): Executable[] {
    return this._executables.filter(e => e.installType === 'download-by-default');
  }

  private _dedupe(executables: Executable[]): ExecutableImpl[] {
    return Array.from(new Set(executables as ExecutableImpl[]));
  }

  private async _validateHostRequirements(sdkLanguage: string, browserDirectory: string, linuxLddDirectories: string[], dlOpenLibraries: string[], windowsExeAndDllDirectories: string[]) {
    if (os.platform() === 'linux')
      return await validateDependenciesLinux(sdkLanguage, linuxLddDirectories.map(d => path.join(browserDirectory, d)), dlOpenLibraries);
    if (os.platform() === 'win32' && os.arch() === 'x64')
      return await validateDependenciesWindows(sdkLanguage, windowsExeAndDllDirectories.map(d => path.join(browserDirectory, d)));
  }

  async installDeps(executablesToInstallDeps: Executable[], dryRun: boolean) {
    const executables = this._dedupe(executablesToInstallDeps);
    const targets = new Set<DependencyGroup>();
    for (const executable of executables) {
      if (executable._dependencyGroup)
        targets.add(executable._dependencyGroup);
    }
    targets.add('tools');
    if (os.platform() === 'win32')
      return await installDependenciesWindows(targets, dryRun);
    if (os.platform() === 'linux')
      return await installDependenciesLinux(targets, dryRun);
  }

  async install(executablesToInstall: Executable[], options?: { force?: boolean }) {
    const executables = this._dedupe(executablesToInstall);
    await fs.promises.mkdir(registryDirectory, { recursive: true });
    const lockfilePath = path.join(registryDirectory, '__dirlock');
    const linksDir = path.join(registryDirectory, '.links');

    let releaseLock;
    try {
      releaseLock = await lockfile.lock(registryDirectory, {
        retries: {
          // Retry 20 times during 10 minutes with
          // exponential back-off.
          // See documentation at: https://www.npmjs.com/package/retry#retrytimeoutsoptions
          retries: 20,
          factor: 1.27579,
        },
        onCompromised: (err: Error) => {
          throw new Error(`${err.message} Path: ${lockfilePath}`);
        },
        lockfilePath,
      });
      // Create a link first, so that cache validation does not remove our own browsers.
      await fs.promises.mkdir(linksDir, { recursive: true });
      await fs.promises.writeFile(path.join(linksDir, calculateSha1(PACKAGE_PATH)), PACKAGE_PATH);

      // Remove stale browsers.
      if (!getAsBooleanFromENV('PLAYWRIGHT_SKIP_BROWSER_GC'))
        await this._validateInstallationCache(linksDir);

      // Install browsers for this package.
      for (const executable of executables) {
        if (!executable._install)
          throw new Error(`ERROR: Playwright does not support installing ${executable.name}`);

        if (!getAsBooleanFromENV('CI') && !executable._isHermeticInstallation && !options?.force && executable.executablePath()) {
          const { embedderName } = getEmbedderName();
          const command = buildPlaywrightCLICommand(embedderName, 'install --force ' + executable.name);
          // eslint-disable-next-line no-restricted-properties
          process.stderr.write('\n' + wrapInASCIIBox([
            `ATTENTION: "${executable.name}" is already installed on the system!`,
            ``,
            `"${executable.name}" installation is not hermetic; installing newer version`,
            `requires *removal* of a current installation first.`,
            ``,
            `To *uninstall* current version and re-install latest "${executable.name}":`,
            ``,
            `- Close all running instances of "${executable.name}", if any`,
            `- Use "--force" to install browser:`,
            ``,
            `    ${command}`,
            ``,
            `<3 Playwright Team`,
          ].join('\n'), 1) + '\n\n');
          return;
        }
        await executable._install(!!options?.force);
      }
    } catch (e) {
      if (e.code === 'ELOCKED') {
        const rmCommand = process.platform === 'win32' ? 'rm -R' : 'rm -rf';
        throw new Error('\n' + wrapInASCIIBox([
          `An active lockfile is found at:`,
          ``,
          `  ${lockfilePath}`,
          ``,
          `Either:`,
          `- wait a few minutes if other Playwright is installing browsers in parallel`,
          `- remove lock manually with:`,
          ``,
          `    ${rmCommand} ${lockfilePath}`,
          ``,
          `<3 Playwright Team`,
        ].join('\n'), 1));
      } else {
        throw e;
      }
    } finally {
      if (releaseLock)
        await releaseLock();
    }
  }

  async uninstall(all: boolean): Promise<{ numberOfBrowsersLeft: number }> {
    const linksDir = path.join(registryDirectory, '.links');
    if (all) {
      const links = await fs.promises.readdir(linksDir).catch(() => []);
      for (const link of links)
        await fs.promises.unlink(path.join(linksDir, link));
    } else {
      await fs.promises.unlink(path.join(linksDir, calculateSha1(PACKAGE_PATH))).catch(() => {});
    }

    // Remove stale browsers.
    await this._validateInstallationCache(linksDir);

    return {
      numberOfBrowsersLeft: (await fs.promises.readdir(registryDirectory).catch(() => [])).filter(browserDirectory => isBrowserDirectory(browserDirectory)).length
    };
  }

  async validateHostRequirementsForExecutablesIfNeeded(executables: Executable[], sdkLanguage: string) {
    if (getAsBooleanFromENV('PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS')) {
      // eslint-disable-next-line no-restricted-properties
      process.stderr.write('Skipping host requirements validation logic because `PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS` env variable is set.\n');
      return;
    }
    for (const executable of executables)
      await this._validateHostRequirementsForExecutableIfNeeded(executable, sdkLanguage);
  }

  private async _validateHostRequirementsForExecutableIfNeeded(executable: Executable, sdkLanguage: string) {
    const kMaximumReValidationPeriod = 30 * 24 * 60 * 60 * 1000; // 30 days
    // Executable does not require validation.
    if (!executable.directory)
      return;
    const markerFile = path.join(executable.directory, 'DEPENDENCIES_VALIDATED');
    // Executable is already validated.
    if (await fs.promises.stat(markerFile).then(stat => (Date.now() - stat.mtime.getTime()) < kMaximumReValidationPeriod).catch(() => false))
      return;

    debugLogger.log('install', `validating host requirements for "${executable.name}"`);
    try {
      await executable._validateHostRequirements(sdkLanguage);
      debugLogger.log('install', `validation passed for ${executable.name}`);
    } catch (error) {
      debugLogger.log('install', `validation failed for ${executable.name}`);
      throw error;
    }

    await fs.promises.writeFile(markerFile, '').catch(() => {});
  }

  private _downloadURLs(descriptor: BrowsersJSONDescriptor): string[] {
    const paths = (DOWNLOAD_PATHS as any)[descriptor.name];
    const downloadPathTemplate: string|DownloadPathFunction|undefined = paths[hostPlatform] || paths['<unknown>'];
    if (!downloadPathTemplate)
      return [];
    let downloadPath: string;
    let mirrors: string[];
    if (typeof downloadPathTemplate === 'function') {
      const result = downloadPathTemplate(descriptor);
      downloadPath = result.path;
      mirrors = result.mirrors;
    } else {
      downloadPath = util.format(downloadPathTemplate, descriptor.revision);
      mirrors = PLAYWRIGHT_CDN_MIRRORS;
    }

    let downloadHostEnv;
    if (descriptor.name.startsWith('chromium'))
      downloadHostEnv = 'PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST';

    const customHostOverride = (downloadHostEnv && getFromENV(downloadHostEnv)) || getFromENV('PLAYWRIGHT_DOWNLOAD_HOST');
    if (customHostOverride)
      mirrors = [customHostOverride];

    return mirrors.map(mirror => `${mirror}/${downloadPath}`);
  }

  private async _downloadExecutable(descriptor: BrowsersJSONDescriptor, force: boolean, executablePath?: string) {
    const downloadURLs = this._downloadURLs(descriptor);
    if (!downloadURLs.length)
      throw new Error(`ERROR: Playwright does not support ${descriptor.name} on ${hostPlatform}`);
    if (!isOfficiallySupportedPlatform)
      logPolitely(`BEWARE: your OS is not officially supported by Playwright; downloading fallback build for ${hostPlatform}.`);
    if (descriptor.hasRevisionOverride) {
      const message = `You are using a frozen ${descriptor.name} browser which does not receive updates anymore on ${hostPlatform}. Please update to the latest version of your operating system to test up-to-date browsers.`;
      if (process.env.GITHUB_ACTIONS)
        console.log(`::warning title=Playwright::${message}`);  // eslint-disable-line no-console
      else
        logPolitely(message);
    }

    const title = this.calculateDownloadTitle(descriptor);
    const downloadFileName = `playwright-download-${descriptor.name}-${hostPlatform}-${descriptor.revision}.zip`;
    // PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT is a misnomer, it actually controls the socket's
    // max idle timeout. Unfortunately, we cannot rename it without breaking existing user workflows.
    const downloadSocketTimeoutEnv = getFromENV('PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT');
    const downloadSocketTimeout = +(downloadSocketTimeoutEnv || '0') || NET_DEFAULT_TIMEOUT;
    await downloadBrowserWithProgressBar(title, descriptor.dir, executablePath, downloadURLs, downloadFileName, downloadSocketTimeout, force).catch(e => {
      throw new Error(`Failed to download ${title}, caused by\n${e.stack}`);
    });
  }

  calculateDownloadTitle(descriptor: BrowsersJSONDescriptor | Executable) {
    const title = descriptor.title ?? descriptor.name.split('-').map(word => {
      return word.charAt(0).toUpperCase() + word.slice(1);
    }).join(' ');
    const version = descriptor.browserVersion ? ' ' + descriptor.browserVersion : '';
    return `${title}${version} (playwright ${descriptor.name} v${descriptor.revision})`;
  }

  private async _installMSEdgeChannel(channel: 'msedge'|'msedge-beta'|'msedge-dev', scripts: Record<'linux' | 'darwin' | 'win32', string>) {
    const scriptArgs: string[] = [];
    if (process.platform !== 'linux') {
      const products = lowercaseAllKeys(JSON.parse(await fetchData(undefined, { url: 'https://edgeupdates.microsoft.com/api/products' })));

      const productName = {
        'msedge': 'Stable',
        'msedge-beta': 'Beta',
        'msedge-dev': 'Dev',
      }[channel];
      const product = products.find((product: any) => product.product === productName);
      const searchConfig = ({
        darwin: { platform: 'MacOS', arch: 'universal', artifact: 'pkg' },
        win32: { platform: 'Windows', arch: 'x64', artifact: 'msi' },
      } as any)[process.platform];
      const release = searchConfig ? product.releases.find((release: any) => release.platform === searchConfig.platform && release.architecture === searchConfig.arch && release.artifacts.length > 0) : null;
      const artifact = release ? release.artifacts.find((artifact: any) => artifact.artifactname === searchConfig.artifact) : null;
      if (artifact)
        scriptArgs.push(artifact.location /* url */);
      else
        throw new Error(`Cannot install ${channel} on ${process.platform}`);
    }
    await this._installChromiumChannel(channel, scripts, scriptArgs);
  }

  private async _installChromiumChannel(channel: string, scripts: Record<'linux' | 'darwin' | 'win32', string>, scriptArgs: string[] = []) {
    const scriptName = scripts[process.platform as 'linux' | 'darwin' | 'win32'];
    if (!scriptName)
      throw new Error(`Cannot install ${channel} on ${process.platform}`);
    const cwd = BIN_PATH;
    const isPowerShell = scriptName.endsWith('.ps1');
    if (isPowerShell) {
      const args = [
        '-ExecutionPolicy', 'Bypass', '-File',
        path.join(BIN_PATH, scriptName),
        ...scriptArgs
      ];
      const { code } = await spawnAsync('powershell.exe', args, { cwd, stdio: 'inherit' });
      if (code !== 0)
        throw new Error(`Failed to install ${channel}`);
    } else {
      const { command, args, elevatedPermissions } = await transformCommandsForRoot([`bash "${path.join(BIN_PATH, scriptName)}" ${scriptArgs.join('')}`]);
      if (elevatedPermissions)
        console.log('Switching to root user to install dependencies...'); // eslint-disable-line no-console
      const { code } = await spawnAsync(command, args, { cwd, stdio: 'inherit' });
      if (code !== 0)
        throw new Error(`Failed to install ${channel}`);
    }
  }

  async listInstalledBrowsers() {
    const linksDir = path.join(registryDirectory, '.links');
    const { browsers } = await this._traverseBrowserInstallations(linksDir);
    return browsers.filter(browser => fs.existsSync(browser.browserPath));
  }

  private async _validateInstallationCache(linksDir: string) {
    const { browsers, brokenLinks } = await this._traverseBrowserInstallations(linksDir);
    await this._deleteStaleBrowsers(browsers);
    await this._deleteBrokenInstallations(brokenLinks);
  }

  private async _traverseBrowserInstallations(linksDir: string): Promise<{ browsers: BrowserInfo[], brokenLinks: string[] }> {
    const browserList: BrowserInfo[] = [];
    const brokenLinks: string[] = [];
    for (const fileName of await fs.promises.readdir(linksDir)) {
      const linkPath = path.join(linksDir, fileName);
      let linkTarget = '';
      try {
        linkTarget = (await fs.promises.readFile(linkPath)).toString();
        const browsersJSON = require(path.join(linkTarget, 'browsers.json'));
        const descriptors = readDescriptors(browsersJSON);
        for (const browserName of allDownloadableDirectoriesThatEverExisted) {
          // We retain browsers if they are found in the descriptor.
          // Note, however, that there are older versions out in the wild that rely on
          // the "download" field in the browser descriptor and use its value
          // to retain and download browsers.
          // As of v1.10, we decided to abandon "download" field.
          const descriptor = descriptors.find(d => d.name === browserName);
          if (!descriptor)
            continue;

          const browserPath = descriptor.dir;
          const browserVersion = parseInt(descriptor.revision, 10);
          browserList.push({
            browserName,
            browserVersion,
            browserPath,
            referenceDir: linkTarget,
          });
        }
      } catch (e) {
        brokenLinks.push(linkPath);
      }
    }

    return { browsers: browserList, brokenLinks };
  }

  private async _deleteStaleBrowsers(browserList: BrowserInfo[]) {
    const usedBrowserPaths: Set<string> = new Set();
    for (const browser of browserList) {
      const { browserName, browserVersion, browserPath } = browser;

      // Old browser installations don't have marker file.
      // We switched chromium from 999999 to 1000, 300000 is the new Y2K.
      const shouldHaveMarkerFile = (browserName === 'chromium' && (browserVersion >= 786218 || browserVersion < 300000)) ||
          // All new applications have a marker file right away.
          (browserName !== 'chromium');
      if (!shouldHaveMarkerFile || (await existsAsync(browserDirectoryToMarkerFilePath(browserPath))))
        usedBrowserPaths.add(browserPath);
    }

    let downloadedBrowsers = (await fs.promises.readdir(registryDirectory)).map(file => path.join(registryDirectory, file));
    downloadedBrowsers = downloadedBrowsers.filter(file => isBrowserDirectory(file));
    const directories = new Set<string>(downloadedBrowsers);
    for (const browserDirectory of usedBrowserPaths)
      directories.delete(browserDirectory);
    for (const directory of directories)
      logPolitely('Removing unused browser at ' + directory);
    await removeFolders([...directories]);
  }

  private async _deleteBrokenInstallations(brokenLinks: string[]) {
    for (const linkPath of brokenLinks)
      await fs.promises.unlink(linkPath).catch(e => {});
  }

  private _defaultBrowsersToInstall(options: { shell?: 'no' | 'only' }): Executable[] {
    let executables = this.defaultExecutables();
    if (options.shell === 'no')
      executables = executables.filter(e => e.name !== 'chromium-headless-shell');
    if (options.shell === 'only')
      executables = executables.filter(e => e.name !== 'chromium');
    return executables;
  }

  suggestedBrowsersToInstall(): string {
    const names: string[] = this.executables().filter(e => e.installType !== 'none').map(e => e.name);
    names.push(...chromiumAliases);
    return names.sort().join(', ');
  }

  isChromiumAlias(name: string): boolean {
    return chromiumAliases.includes(name);
  }

  resolveBrowsers(aliases: string[], options: { shell?: 'no' | 'only' }): Executable[] {
    if (aliases.length === 0)
      return this._defaultBrowsersToInstall(options);

    const faultyArguments: string[] = [];
    const executables: Executable[] = [];
    const handleArgument = (arg: string) => {
      const executable = this.findExecutable(arg);
      if (!executable || executable.installType === 'none')
        faultyArguments.push(arg);
      else
        executables.push(executable);
    };

    for (const alias of aliases) {
      if (alias === 'chromium' || chromiumAliases.includes(alias)) {
        if (options.shell !== 'only')
          handleArgument('chromium');
        if (options.shell !== 'no')
          handleArgument('chromium-headless-shell');
      } else {
        handleArgument(alias);
      }
    }

    if (faultyArguments.length)
      throw new Error(`Invalid installation targets: ${faultyArguments.map(name => `'${name}'`).join(', ')}. Expecting one of: ${this.suggestedBrowsersToInstall()}`);
    return executables;
  }
}

export function browserDirectoryToMarkerFilePath(browserDirectory: string): string {
  return path.join(browserDirectory, 'INSTALLATION_COMPLETE');
}

export function buildPlaywrightCLICommand(sdkLanguage: string, parameters: string): string {
  switch (sdkLanguage) {
    case 'python':
      return `playwright ${parameters}`;
    case 'java':
      return `mvn exec:java -e -D exec.mainClass=com.microsoft.playwright.CLI -D exec.args="${parameters}"`;
    case 'csharp':
      return `pwsh bin/Debug/netX/playwright.ps1 ${parameters}`;
    default: {
      const packageManagerCommand = getPackageManagerExecCommand();
      return `${packageManagerCommand} playwright ${parameters}`;
    }
  }
}

export async function installBrowsersForNpmInstall(browsers: string[]) {
  // PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD should have a value of 0 or 1
  if (getAsBooleanFromENV('PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD')) {
    logPolitely('Skipping browsers download because `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD` env variable is set');
    return false;
  }
  const executables: Executable[] = [];
  for (const browserName of browsers) {
    const executable = registry.findExecutable(browserName);
    if (!executable || executable.installType === 'none')
      throw new Error(`Cannot install ${browserName}`);
    executables.push(executable);
  }

  await registry.install(executables);
}

// for launchApp -> UI Mode / Trace Viewer
export function findChromiumChannelBestEffort(sdkLanguage: string): string | undefined {
  // Fall back to the stable channels of popular vendors to work out of the box.
  // Null means no installation and no channels found.
  let channel = null;
  for (const name of ['chromium', 'chrome', 'msedge']) {
    try {
      registry.findExecutable(name)!.executablePathOrDie(sdkLanguage);
      channel = name === 'chromium' ? undefined : name;
      break;
    } catch (e) {
    }
  }

  if (channel === null) {
    const installCommand = buildPlaywrightCLICommand(sdkLanguage, `install chromium`);
    const prettyMessage = [
      `No chromium-based browser found on the system.`,
      `Please run the following command to download one:`,
      ``,
      `    ${installCommand}`,
      ``,
      `<3 Playwright Team`,
    ].join('\n');
    throw new Error('\n' + wrapInASCIIBox(prettyMessage, 1));
  }
  return channel;
}

function lowercaseAllKeys(json: any): any {
  if (typeof json !== 'object' || !json)
    return json;

  if (Array.isArray(json))
    return json.map(lowercaseAllKeys);

  const result: any = {};
  for (const [key, value] of Object.entries(json))
    result[key.toLowerCase()] = lowercaseAllKeys(value);
  return result;
}

export const registry = new Registry(require('../../../browsers.json'));
