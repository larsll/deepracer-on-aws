// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import Grid from '@cloudscape-design/components/grid';
import SpaceBetween from '@cloudscape-design/components/space-between';
import type { TimingMethod } from '@deepracer-indy/typescript-client';

import type { LiveRaceEvent } from '#pages/LiveRace/types/events.js';

import type { LiveRaceState } from '../../liveRaceState.js';
import LeaderboardPanel from '../LeaderboardPanel';
import ParticipantNotificationToast from '../ParticipantNotificationToast';
import QueueManagementPanel from '../QueueManagementPanel';
import RaceProgressBar from '../RaceProgressBar';
import RaceVideoPanel from '../RaceVideoPanel';
import WinnerOverlay from '../WinnerOverlay';

interface NormalContentProps {
  raceState: LiveRaceState;
  timingMethod: TimingMethod | undefined;
  isFacilitator: boolean;
  lastNotificationEvent: LiveRaceEvent | null;
  profileId: string;
  onQueueReorder: (submissionId: string, afterSubmissionId: string | null) => void;
  onQueueRemove: (submissionId: string) => void;
  onQueueReset: (submissionId: string) => void;
  onToggleAutolaunch: (enabled: boolean) => void;
  onToggleSubmissions: (open: boolean) => void;
  onWinnerDismiss: () => void;
}

const NormalContent = ({
  raceState,
  timingMethod,
  isFacilitator,
  lastNotificationEvent,
  profileId,
  onQueueReorder,
  onQueueRemove,
  onQueueReset,
  onToggleAutolaunch,
  onToggleSubmissions,
  onWinnerDismiss,
}: NormalContentProps) => {
  const noop = () => undefined;
  const reorderFn = isFacilitator ? onQueueReorder : noop;
  const removeFn = isFacilitator ? onQueueRemove : noop;
  const resetFn = isFacilitator ? onQueueReset : noop;
  const autolaunchEnabled = isFacilitator ? raceState.autolaunchEnabled : undefined;
  const submissionPeriodOpen = isFacilitator ? raceState.submissionPeriodOpen : undefined;
  const toggleAutolaunchFn = isFacilitator ? onToggleAutolaunch : undefined;
  const toggleSubmissionsFn = isFacilitator ? onToggleSubmissions : undefined;

  return (
    <div data-testid="live-race-content">
      <SpaceBetween size="m">
        <Grid gridDefinition={[{ colspan: { default: 12, s: 8 } }, { colspan: { default: 12, s: 4 } }]}>
          <SpaceBetween size="s">
            <RaceVideoPanel raceState={raceState} />
            <RaceProgressBar completedModels={raceState.completedModels} totalModels={raceState.queueItems.length} />
          </SpaceBetween>
          <LeaderboardPanel rankings={raceState.rankings} timingMethod={timingMethod} />
        </Grid>
        <QueueManagementPanel
          items={raceState.queueItems}
          onReorder={reorderFn}
          onRemove={removeFn}
          onReset={resetFn}
          isRaceCompleted={raceState.raceStatus === 'COMPLETED'}
          readOnly={!isFacilitator}
          autolaunchEnabled={autolaunchEnabled}
          submissionPeriodOpen={submissionPeriodOpen}
          onToggleAutolaunch={toggleAutolaunchFn}
          onToggleSubmissions={toggleSubmissionsFn}
        />
      </SpaceBetween>
      <ParticipantNotificationToast lastEvent={lastNotificationEvent} currentProfileId={profileId} />
      <WinnerOverlay winner={raceState.winner} onDismiss={onWinnerDismiss} />
    </div>
  );
};

export default NormalContent;
