// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { LiveRaceState } from '../../liveRaceState.js';
import VideoPanel from '../VideoPanel';

interface RaceVideoPanelProps {
  raceState: LiveRaceState;
}

const RaceVideoPanel = ({ raceState }: RaceVideoPanelProps) => (
  <VideoPanel
    streamUrl={raceState.streamUrl}
    participantName={raceState.participantName ?? ''}
    modelName={raceState.modelName ?? ''}
    allComplete={
      raceState.queueItems.length > 0 &&
      !raceState.queueItems.some((i) => i.status === 'PENDING' || i.status === 'IN_PROGRESS')
    }
    hasFailed={raceState.queueItems.some((i) => i.status === 'FAILED')}
    winnerDeclared={raceState.raceStatus === 'COMPLETED'}
    waitingForLaunch={
      !raceState.isExecutionRunning &&
      raceState.raceStatus !== 'COMPLETED' &&
      raceState.queueItems.every((i) => i.status === 'PENDING')
    }
    isExecutionRunning={raceState.queueItems.some((i) => i.status === 'IN_PROGRESS')}
  />
);

export default RaceVideoPanel;
