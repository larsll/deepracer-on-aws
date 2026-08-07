// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import SpaceBetween from '@cloudscape-design/components/space-between';
import { useTranslation } from 'react-i18next';

import deepRacerLogo from '#assets/deepracer_logo.svg';
import type { LiveRaceEvent } from '#pages/LiveRace/types/events.js';

import type { LiveRaceState } from '../../liveRaceState.js';
import ParticipantNotificationToast from '../ParticipantNotificationToast';
import RaceProgressBar from '../RaceProgressBar';
import RacerInfoBanner from '../RacerInfoBanner';
import RaceVideoPanel from '../RaceVideoPanel';
import WinnerOverlay from '../WinnerOverlay';

interface BroadcastContentProps {
  raceState: LiveRaceState;
  leaderboardName: string | undefined;
  leaderboardId: string;
  cursorHidden: boolean;
  lastNotificationEvent: LiveRaceEvent | null;
  profileId: string;
}

const BroadcastContent = ({
  raceState,
  leaderboardName,
  leaderboardId,
  cursorHidden,
  lastNotificationEvent,
  profileId,
}: BroadcastContentProps) => {
  const { t } = useTranslation('liveRace');

  return (
    <div className={`broadcastLayout${cursorHidden ? ' cursorHidden' : ''}`} data-testid="live-race-content">
      <img src={deepRacerLogo} alt="DeepRacer on AWS" className="broadcastLogo" />
      <SpaceBetween size="s">
        <div className="broadcastRaceName">
          {leaderboardName ?? leaderboardId}
          {raceState.raceStatus === 'IN_PROGRESS' && (
            <span className="liveBadge">
              <span className="liveDot" /> {t('header.live')}
            </span>
          )}
        </div>
        <RacerInfoBanner participantName={raceState.participantName} avatar={raceState.currentAvatar ?? undefined} />
        <RaceVideoPanel raceState={raceState} />
        <RaceProgressBar completedModels={raceState.completedModels} totalModels={raceState.queueItems.length} />
      </SpaceBetween>
      <ParticipantNotificationToast lastEvent={lastNotificationEvent} currentProfileId={profileId} />
      <WinnerOverlay winner={raceState.winner} />
    </div>
  );
};

export default BroadcastContent;
