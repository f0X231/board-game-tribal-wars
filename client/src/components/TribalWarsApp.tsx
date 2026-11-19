"use client";

import { useState } from "react";
import type { GameConfig } from "@shared/gameEngine";
import { ArtDefs } from "./art";
import { Lobby } from "./Lobby";
import { MatchScreen } from "./MatchScreen";

const DEFAULT_CONFIG: GameConfig = { boardSize: 10, playerCount: 2, piecesPerPlayer: 4, placementMode: "MANUAL" };

export function TribalWarsApp() {
  const [config, setConfig] = useState<GameConfig>(DEFAULT_CONFIG);
  const [inMatch, setInMatch] = useState(false);
  const [matchId, setMatchId] = useState(0);

  return (
    <>
      <ArtDefs />
      {inMatch ? (
        <MatchScreen key={matchId} config={config} onLobby={() => setInMatch(false)} />
      ) : (
        <Lobby
          initial={config}
          onStart={(c) => {
            setConfig(c);
            setMatchId((id) => id + 1);
            setInMatch(true);
          }}
        />
      )}
    </>
  );
}
