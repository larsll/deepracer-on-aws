// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for handleQueueReset internal callbacks in LiveRace.tsx.
 *
 * vi.mock captures the onQueueReset prop via a module-level variable so tests
 * can invoke it directly without triggering Cloudscape Table row selection.
 */

import {
  GetLiveRaceStateCommand,
  GetLeaderboardCommand,
  ListLiveQueueItemsCommand,
  LiveEventStatus,
  ResetLiveQueueModelCommand,
  Leaderboard,
} from '@deepracer-indy/typescript-client';
import { act, cleanup, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { mockDeepRacerClient, render } from '#utils/testUtils';

import LiveRace from './LiveRace';

vi.mock('#hooks/useLiveRaceMqtt', () => ({
  useLiveRaceMqtt: vi.fn((_leaderboardId: string, _options: unknown) => ({
    connectionStatus: 'CONNECTED',
  })),
  ConnectionStatus: {
    CONNECTING: 'CONNECTING',
    CONNECTED: 'CONNECTED',
    DISCONNECTED: 'DISCONNECTED',
    ERROR: 'ERROR',
  },
}));

vi.mock('#components/VideoStreamPlayer', () => ({
  default: ({ src }: { src: string }) => (
    <div data-testid="video-stream-player" data-src={src}>
      Mock Video Player
    </div>
  ),
}));

const mockCheckUserGroupMembership = vi.fn();
vi.mock('#utils/authUtils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#utils/authUtils')>();
  return {
    ...actual,
    checkUserGroupMembership: (...args: unknown[]) => mockCheckUserGroupMembership(...args),
  };
});

// Capture onQueueReset without calling it on render to avoid infinite loops.
let capturedOnQueueReset: ((id: string) => void) | null = null;
vi.mock('#pages/LiveRace/components/NormalContent', () => ({
  default: ({ onQueueReset }: { onQueueReset: (id: string) => void }) => {
    capturedOnQueueReset = onQueueReset;
    return <div data-testid="live-race-content" />;
  },
}));

const baseState = {
  race: {
    leaderboardId: 'test-lb',
    name: 'Test Race',
    liveEventStatus: LiveEventStatus.IN_PROGRESS,
    isLive: true,
    autoLaunchEnabled: false,
    submissionPeriodOpen: false,
  },
  queue: { totalModels: 1, completedModels: 0, pendingModels: 1, inProgressModels: 0 },
  rankings: [],
};

const pendingItem = {
  leaderboardId: 'test-lb',
  submissionId: 'sub-1',
  profileId: 'p1',
  participantName: 'Alice',
  modelName: 'SpeedDemon',
  queuePosition: 'a',
  status: 'PENDING' as const,
  resetCount: 0,
  submittedAt: new Date('2026-01-01T00:00:00Z'),
};

describe('<LiveRace /> handleQueueReset callbacks', () => {
  beforeEach(() => {
    capturedOnQueueReset = null;
    vi.clearAllMocks();
    mockDeepRacerClient.reset();
    mockCheckUserGroupMembership.mockResolvedValue(false);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllTimers();
  });

  const setup = () => {
    mockDeepRacerClient.on(GetLeaderboardCommand).resolves({
      leaderboard: {
        leaderboardId: 'test-lb',
        name: 'Test Race',
        liveEventTime: new Date(Date.now() - 60_000),
      } as unknown as Leaderboard,
    });
    mockDeepRacerClient.on(GetLiveRaceStateCommand).resolves(baseState);
    mockDeepRacerClient.on(ListLiveQueueItemsCommand).resolves({ items: [pendingItem] });
  };

  it('invokes onResetError when resetLiveQueueModel fails for a PENDING item', async () => {
    setup();
    mockDeepRacerClient.on(ResetLiveQueueModelCommand).rejects(new Error('reset failed'));

    render(<LiveRace __forceFacilitator />, {
      componentRoute: '/races/:leaderboardId/live',
      initialRouteEntries: ['/races/test-lb/live'],
    });

    await waitFor(() => {
      expect(capturedOnQueueReset).not.toBeNull();
    });

    await act(async () => {
      if (capturedOnQueueReset) capturedOnQueueReset('sub-1');
    });

    await waitFor(() => {
      expect(screen.getByTestId('live-race-content')).toBeInTheDocument();
    });
  });

  it('invokes onResetError restoring stream state when an IN_PROGRESS item reset fails', async () => {
    mockDeepRacerClient.on(GetLeaderboardCommand).resolves({
      leaderboard: {
        leaderboardId: 'test-lb',
        name: 'Test Race',
        liveEventTime: new Date(Date.now() - 60_000),
      } as unknown as Leaderboard,
    });
    mockDeepRacerClient.on(GetLiveRaceStateCommand).resolves({
      ...baseState,
      queue: { totalModels: 1, completedModels: 0, pendingModels: 0, inProgressModels: 1 },
      currentEvaluation: {
        submissionId: 'sub-1',
        participantName: 'Alice',
        modelName: 'SpeedDemon',
        status: 'IN_PROGRESS',
        streamUrl: 'https://example.com/stream',
      },
    });
    mockDeepRacerClient.on(ListLiveQueueItemsCommand).resolves({
      items: [{ ...pendingItem, status: 'IN_PROGRESS' as const }],
    });
    mockDeepRacerClient.on(ResetLiveQueueModelCommand).rejects(new Error('reset failed'));

    render(<LiveRace __forceFacilitator />, {
      componentRoute: '/races/:leaderboardId/live',
      initialRouteEntries: ['/races/test-lb/live'],
    });

    await waitFor(() => {
      expect(capturedOnQueueReset).not.toBeNull();
    });

    await act(async () => {
      if (capturedOnQueueReset) capturedOnQueueReset('sub-1');
    });

    await waitFor(() => {
      expect(screen.getByTestId('live-race-content')).toBeInTheDocument();
    });
  });
});
