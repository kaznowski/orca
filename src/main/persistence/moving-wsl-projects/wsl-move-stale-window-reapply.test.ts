import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultPersistedState, getDefaultWorkspaceSession } from '../../../shared/constants'
import { toRuntimeExecutionHostId } from '../../../shared/execution-host'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { WSL_HOSTS_INTERNAL_GATE_ENV } from '../../../shared/wsl-host-internal-gate'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { Store } from '../../persistence'
import {
  closeTestStores,
  createStore,
  readPersistedStateJson,
  testState,
  writeDataFile
} from '../../persistence-test-harness'
import { wslMoveCutoverFixture } from '../__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { seedWslMoveCutover } from '../__fixtures__/wsl-mover/wsl-move-journal-seeding'
import { wslMoverProfile } from '../__fixtures__/wsl-mover/wsl-mover-profiles'
import { unifiedTab } from '../__fixtures__/wsl-mover/wsl-mover-profile-rows'
import { runWslMoveDesktopRewritePass } from './wsl-move-desktop-rewrite'
import { resetWslMoveDesktopRewriteStoresForTests } from './wsl-move-desktop-rewrite-stores'
import { registerWslMoveMainRewriteStores } from './wsl-move-main-rewrite-stores'
import { loadWslMoveFence, resetWslMoveFenceForTests } from './wsl-move-scope-guard'
import { reapplyWslMoveRewritesAtUnload } from './wsl-move-stale-window-reapply'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))

const ENVIRONMENT = 'wsl:Ubuntu'
const HOST = toRuntimeExecutionHostId(ENVIRONMENT)
const source = wslMoverProfile('mixed-windows-wsl', 'source')
const MOVED = source.session.activeWorktreeId ?? ''
const MOVED_ON_HOST = 'repo-a::/home/dev/app'
const README_ON_HOST = '/home/dev/app/README.md'
const DRAFT = '# unsaved draft'
const BROWSER_URL = 'https://example.com/'

function browserRows(owner: string): Partial<WorkspaceSessionState> {
  return {
    browserTabsByWorktree: {
      [owner]: [
        {
          id: 'bw-web',
          worktreeId: owner,
          url: BROWSER_URL,
          title: 'Example Domain',
          loading: false,
          faviconUrl: null,
          canGoBack: false,
          canGoForward: false,
          loadError: null,
          createdAt: 3
        }
      ]
    },
    browserPagesByWorkspace: {
      'bw-web': [
        {
          id: 'page-web',
          workspaceId: 'bw-web',
          worktreeId: owner,
          url: BROWSER_URL,
          title: 'Example Domain',
          loading: false,
          faviconUrl: null,
          canGoBack: false,
          canGoForward: false,
          loadError: null,
          createdAt: 3
        }
      ]
    }
  }
}

/** The moved project's rows as the manifest carries them: host ids, no draft (the export strips it). */
function carriedSession(): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    ...browserRows(MOVED_ON_HOST),
    openFilesByWorktree: {
      [MOVED_ON_HOST]: [
        {
          filePath: README_ON_HOST,
          relativePath: 'README.md',
          worktreeId: MOVED_ON_HOST,
          language: 'markdown'
        }
      ]
    },
    unifiedTabs: {
      [MOVED_ON_HOST]: [
        unifiedTab(README_ON_HOST, MOVED_ON_HOST, 'group-1'),
        {
          ...unifiedTab('browser-tab', MOVED_ON_HOST, 'group-1'),
          contentType: 'browser',
          entityId: 'bw-web'
        }
      ]
    },
    tabGroups: {
      [MOVED_ON_HOST]: [
        {
          id: 'group-1',
          worktreeId: MOVED_ON_HOST,
          activeTabId: 'browser-tab',
          tabOrder: [README_ON_HOST, 'browser-tab']
        }
      ]
    },
    activeGroupIdByWorktree: { [MOVED_ON_HOST]: 'group-1' }
  }
}

/**
 * The window's mirror of what the host publishes for the moved project: the editor it reopened,
 * without the draft (the host never had it), and no browser tab (the host has no browser).
 */
function windowMirror(): WorkspaceSessionState {
  const group = `headless-terminals:${MOVED_ON_HOST}`
  return {
    ...getDefaultWorkspaceSession(),
    openFilesByWorktree: {
      [MOVED_ON_HOST]: [
        {
          filePath: README_ON_HOST,
          relativePath: 'README.md',
          worktreeId: MOVED_ON_HOST,
          language: 'markdown',
          runtimeEnvironmentId: ENVIRONMENT
        }
      ]
    },
    unifiedTabs: {
      [MOVED_ON_HOST]: [unifiedTab(README_ON_HOST, MOVED_ON_HOST, group)]
    },
    tabGroups: {
      [MOVED_ON_HOST]: [
        {
          id: group,
          worktreeId: MOVED_ON_HOST,
          activeTabId: README_ON_HOST,
          tabOrder: [README_ON_HOST]
        }
      ]
    },
    activeGroupIdByWorktree: { [MOVED_ON_HOST]: group }
  }
}

function committedMove() {
  return wslMoveCutoverFixture(
    'move-1',
    'destination-committed',
    { destinationEnvironmentId: ENVIRONMENT },
    { repoIds: ['repo-a'] },
    {
      version: 1,
      worktreeMeta: [],
      worktreeLineage: [],
      workspaceLineage: [],
      sparsePresets: [],
      retiredWorktreeNames: [],
      retiredWorktreeNamespaces: [],
      workspaceSession: carriedSession()
    }
  )
}

function hostSession(): WorkspaceSessionState | undefined {
  const saved: PersistedState = JSON.parse(readPersistedStateJson())
  return saved.workspaceSessionsByHostId?.[HOST]
}

let store: Store
beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'wsl-move-stale-window-'))
  vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '1')
  writeDataFile({
    ...getDefaultPersistedState(testState.dir),
    repos: source.state.repos,
    workspaceSession: {
      ...getDefaultWorkspaceSession(),
      ...source.session,
      // The browser tab the user opened in the moved project just before Move.
      browserTabsByWorktree: browserRows(MOVED).browserTabsByWorktree ?? {},
      browserPagesByWorkspace: browserRows(MOVED).browserPagesByWorkspace ?? {},
      activeWorkspaceExecutionHostId: 'local'
    }
  })
  store = createStore()
  registerWslMoveMainRewriteStores(store, () => true)
})
afterEach(async () => {
  vi.unstubAllEnvs()
  resetWslMoveDesktopRewriteStoresForTests()
  resetWslMoveFenceForTests()
  await closeTestStores()
  rmSync(testState.dir, { recursive: true, force: true })
})

describe('a move rewritten under an open window, then reloaded', () => {
  it.each([
    ['the host published the project before the rewrite', true],
    ['the rewrite seeded the host copy first', false]
  ])('keeps the moved browser tab and draft when %s', async (_name, publishedFirst) => {
    expect(store.getWorkspaceSession().openFilesByWorktree?.[MOVED]?.[0]?.dirtyDraftContent).toBe(
      DRAFT
    )
    if (publishedFirst) {
      store.setWorkspaceSession(windowMirror(), HOST)
    }
    seedWslMoveCutover(testState.dir, committedMove())
    loadWslMoveFence(testState.dir)
    await runWslMoveDesktopRewritePass({ userDataPath: testState.dir })
    // The open window saves its mirror of the host over whatever the rewrite seeded.
    store.setWorkspaceSession(windowMirror(), HOST)

    reapplyWslMoveRewritesAtUnload(testState.dir, store)
    await store.flushPendingOrThrowAsync()

    const host = hostSession()
    expect(host?.browserPagesByWorkspace?.['bw-web']?.[0]?.url).toBe(BROWSER_URL)
    expect(host?.browserTabsByWorktree?.[MOVED_ON_HOST]?.map((tab) => tab.id)).toEqual(['bw-web'])
    expect(
      host?.openFilesByWorktree?.[MOVED_ON_HOST]?.find((file) => file.filePath === README_ON_HOST)
        ?.dirtyDraftContent
    ).toBe(DRAFT)
  })
})
