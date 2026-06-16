import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import WipInteractiveCard from '../components/WipInteractiveCard';
import { CARD_NFT_2_MAX_CARD_ID, normalizeCardNft2CardId } from '../lib/cardNft2Assets';
import { getInteractiveCardPackCardByFigureId } from '../lib/interactiveCardPackReveal';
import { drifCardIdentityKey, getDrifCardAssetSources, type DrifCardConfig } from '../drifCards';
import { recordCard, type RecordProgress } from './recordCard';

type OutputDirectoryHandle = {
  name?: string;
  getFileHandle: (
    name: string,
    options?: { create?: boolean },
  ) => Promise<{
    createWritable: () => Promise<FileSystemWritableFileStream>;
  }>;
};

type DirectoryPickerWindow = Window &
  typeof globalThis & {
    showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<OutputDirectoryHandle>;
    cardNft2Renderer?: {
      renderIdsToDownloads: (ids: number[]) => Promise<string[]>;
    };
  };

type QueueEntryStatus = 'queued' | 'preloading' | 'ready' | 'rendering' | 'done' | 'failed';

type QueueEntry = {
  id: number;
  status: QueueEntryStatus;
  phase?: string;
  progress?: number;
  filename?: string;
  error?: string;
};

const DEFAULT_START_ID = 1;
const DEFAULT_END_ID = 4;
const DEFAULT_ID_LIST_INPUT = '';
const CARD_READY_TIMEOUT_MS = 20_000;
const CARD_READY_POLL_MS = 100;
const CARD_SETTLE_DELAY_MS = 300;
const ON_CANVAS_LAYOUT = {
  background: '/card_nft_2/canvas_h.jpeg',
  // Keep the horizontal canvas MP4-friendly for browser H.264 encoders.
  outputSize: {
    width: 1872,
    height: 1408,
  },
  cardWidth: 0.15,
  cardPosition: {
    x: 0.362,
    y: 0.202,
  },
} as const;

type CanvasPreviewStyle = CSSProperties & {
  '--renderer-canvas-card-width'?: string;
  '--renderer-canvas-card-x'?: string;
  '--renderer-canvas-card-y'?: string;
};

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function normalizeInputId(value: string) {
  return normalizeCardNft2CardId(value);
}

function buildRange(startId: number, endId: number) {
  const first = Math.min(startId, endId);
  const last = Math.max(startId, endId);
  return Array.from({ length: last - first + 1 }, (_, index) => first + index);
}

function uniqueIds(ids: readonly number[]) {
  const seen = new Set<number>();
  return ids.filter((id) => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function parseIdListInput(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const tokens = trimmed.split(',');
  if (tokens.some((token) => !token.trim())) {
    return {
      valid: false,
      ids: [] as number[],
      message: `Use comma-separated IDs from 1 to ${CARD_NFT_2_MAX_CARD_ID}.`,
      mode: 'list' as const,
    };
  }

  const ids: number[] = [];
  for (const token of tokens) {
    const id = normalizeInputId(token);
    if (!id) {
      return {
        valid: false,
        ids: [] as number[],
        message: `Use comma-separated IDs from 1 to ${CARD_NFT_2_MAX_CARD_ID}.`,
        mode: 'list' as const,
      };
    }
    ids.push(id);
  }

  const unique = uniqueIds(ids);
  return {
    valid: true,
    ids: unique,
    message: `${unique.length} card${unique.length === 1 ? '' : 's'} from list`,
    mode: 'list' as const,
  };
}

async function decodeBlobAsImage(blob: Blob, src: string) {
  const objectUrl = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.decoding = 'async';
    image.src = objectUrl;
    await image.decode().catch(() => {
      if (image.complete && image.naturalWidth > 0) return;
      throw new Error(`Failed to decode ${src}`);
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function preloadAsset(src: string) {
  const url = new URL(src, window.location.href).href;
  const response = await fetch(url, { cache: 'force-cache' });
  if (!response.ok) throw new Error(`Failed to preload ${src}: ${response.status}`);
  const blob = await response.blob();
  if (!blob.size) throw new Error(`Downloaded empty asset: ${src}`);
  await decodeBlobAsImage(blob, src);
}

async function preloadCardAssets(card: DrifCardConfig) {
  const sources = getDrifCardAssetSources(card);
  await Promise.all(sources.map((src) => preloadAsset(src)));
}

function cardForId(id: number) {
  const card = getInteractiveCardPackCardByFigureId('card_nft_2', id);
  if (!card) throw new Error(`No card_nft_2 card config for ID ${id}`);
  return card;
}

function statusLabel(status: QueueEntryStatus) {
  if (status === 'preloading') return 'preloading';
  if (status === 'ready') return 'ready';
  if (status === 'rendering') return 'rendering';
  if (status === 'done') return 'done';
  if (status === 'failed') return 'failed';
  return 'queued';
}

function progressLabel(entry: QueueEntry) {
  if (entry.status === 'done') return entry.filename || 'done';
  if (entry.status === 'failed') return entry.error || 'failed';
  if (entry.phase) {
    const pct = typeof entry.progress === 'number' ? ` ${Math.round(entry.progress * 100)}%` : '';
    return `${entry.phase}${pct}`;
  }
  return statusLabel(entry.status);
}

export default function RendererApp() {
  const [idListInput, setIdListInput] = useState(DEFAULT_ID_LIST_INPUT);
  const [startIdInput, setStartIdInput] = useState(String(DEFAULT_START_ID));
  const [endIdInput, setEndIdInput] = useState(String(DEFAULT_END_ID));
  const [outputDirectory, setOutputDirectory] = useState<OutputDirectoryHandle | null>(null);
  const [currentCardId, setCurrentCardId] = useState(DEFAULT_START_ID);
  const [currentCard, setCurrentCard] = useState<DrifCardConfig>(() => cardForId(DEFAULT_START_ID));
  const [previewRevision, setPreviewRevision] = useState(0);
  const [imageReady, setImageReady] = useState(false);
  const [renderOnCanvas, setRenderOnCanvas] = useState(false);
  const [queue, setQueue] = useState<QueueEntry[]>([]);
  const [running, setRunning] = useState(false);
  const [lastError, setLastError] = useState('');
  const previewRef = useRef<HTMLDivElement | null>(null);
  const imageReadyRef = useRef(false);
  const runningRef = useRef(false);

  const renderSelection = useMemo(() => {
    const parsedList = parseIdListInput(idListInput);
    if (parsedList) return parsedList;

    const startId = normalizeInputId(startIdInput);
    const endId = normalizeInputId(endIdInput);
    if (!startId || !endId) {
      return {
        valid: false,
        ids: [] as number[],
        message: `Use IDs from 1 to ${CARD_NFT_2_MAX_CARD_ID}.`,
        mode: 'range' as const,
      };
    }
    const ids = buildRange(startId, endId);
    return {
      valid: true,
      ids,
      message: `${ids.length} card${ids.length === 1 ? '' : 's'}`,
      mode: 'range' as const,
    };
  }, [endIdInput, idListInput, startIdInput]);

  const currentCardKey = useMemo(() => `${drifCardIdentityKey(currentCard)}:${previewRevision}`, [currentCard, previewRevision]);

  const previewStyle = useMemo<CanvasPreviewStyle | undefined>(() => {
    if (!renderOnCanvas) return undefined;
    return {
      backgroundImage: `url("${ON_CANVAS_LAYOUT.background}")`,
      '--renderer-canvas-card-width': `${ON_CANVAS_LAYOUT.cardWidth * 100}%`,
      '--renderer-canvas-card-x': `${ON_CANVAS_LAYOUT.cardPosition.x * 100}%`,
      '--renderer-canvas-card-y': `${ON_CANVAS_LAYOUT.cardPosition.y * 100}%`,
    };
  }, [renderOnCanvas]);

  const setQueueEntry = useCallback((id: number, patch: Partial<QueueEntry>) => {
    setQueue((entries) => entries.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)));
  }, []);

  const handleImageReadyChange = useCallback((ready: boolean) => {
    imageReadyRef.current = ready;
    setImageReady(ready);
  }, []);

  const chooseOutputDirectory = useCallback(async () => {
    const picker = (window as DirectoryPickerWindow).showDirectoryPicker;
    if (!picker) {
      setLastError('This browser does not expose showDirectoryPicker. Use Chrome or Edge.');
      return;
    }

    try {
      const directory = await picker({ mode: 'readwrite' });
      setOutputDirectory(directory);
      setLastError('');
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setLastError(formatError(error));
    }
  }, []);

  const waitForPreviewCardReady = useCallback(async (id: number) => {
    const startedAt = performance.now();
    while (performance.now() - startedAt < CARD_READY_TIMEOUT_MS) {
      const cardElement = previewRef.current?.querySelector<HTMLElement>('.drif-effect-card');
      if (cardElement && imageReadyRef.current && !cardElement.classList.contains('loading')) {
        return cardElement;
      }
      await sleep(CARD_READY_POLL_MS);
    }
    throw new Error(`Timed out waiting for card ${id} to become ready`);
  }, []);

  const preparePreviewCard = useCallback(
    async (id: number) => {
      const card = cardForId(id);
      setQueueEntry(id, { status: 'preloading', phase: 'preloading', progress: undefined, error: undefined });
      await preloadCardAssets(card);
      flushSync(() => {
        imageReadyRef.current = false;
        setImageReady(false);
        setCurrentCardId(id);
        setCurrentCard(card);
        setPreviewRevision((value) => value + 1);
      });
      setQueueEntry(id, { status: 'ready', phase: 'ready' });
      await sleep(0);
      const element = await waitForPreviewCardReady(id);
      await sleep(CARD_SETTLE_DELAY_MS);
      return element;
    },
    [setQueueEntry, waitForPreviewCardReady],
  );

  const renderIds = useCallback(
    async (
      ids: readonly number[],
      output: {
        createWritable?: (name: string) => Promise<FileSystemWritableFileStream>;
        saveBlob?: (blob: Blob, name: string) => Promise<void> | void;
      },
    ) => {
      runningRef.current = true;
      setRunning(true);
      setLastError('');
      setQueue(ids.map((id) => ({ id, status: 'queued' as const })));

      const renderedFiles: string[] = [];
      try {
        for (const id of ids) {
          if (!runningRef.current) break;
          try {
            const cardElement = await preparePreviewCard(id);
            setQueueEntry(id, { status: 'rendering', phase: 'preparing', progress: 0 });

            const result = await recordCard(
              cardElement,
              ({ phase, current, total }: RecordProgress) => {
                setQueueEntry(id, {
                  status: phase === 'done' ? 'done' : 'rendering',
                  phase,
                  progress: total > 0 ? current / total : undefined,
                });
              },
              {
                filename: `card-nft-2-${id}.mp4`,
                createWritable: output.createWritable,
                saveBlob: output.saveBlob,
                canvasBackground: renderOnCanvas ? ON_CANVAS_LAYOUT.background : 'none',
                cardSize: renderOnCanvas ? 'custom' : 'default',
                customCardWidth: renderOnCanvas ? ON_CANVAS_LAYOUT.cardWidth : undefined,
                outputSize: renderOnCanvas ? ON_CANVAS_LAYOUT.outputSize : undefined,
                cardPosition: renderOnCanvas ? ON_CANVAS_LAYOUT.cardPosition : undefined,
                requireMp4: renderOnCanvas,
                verticalOffset: 0,
                speed: 1,
              },
            );

            renderedFiles.push(result.filename);
            setQueueEntry(id, { status: 'done', phase: 'done', progress: 1, filename: result.filename });
            await sleep(200);
          } catch (error) {
            const message = formatError(error);
            setQueueEntry(id, { status: 'failed', phase: 'failed', error: message });
            throw error;
          }
        }
        return renderedFiles;
      } catch (error) {
        const message = formatError(error);
        setLastError(message);
        throw error;
      } finally {
        runningRef.current = false;
        setRunning(false);
      }
    },
    [preparePreviewCard, renderOnCanvas, setQueueEntry],
  );

  const renderToDirectory = useCallback(async () => {
    if (!renderSelection.valid || !renderSelection.ids.length) {
      setLastError(renderSelection.message);
      return;
    }
    if (!outputDirectory) {
      setLastError('Pick an output folder before rendering.');
      return;
    }

    try {
      await renderIds(renderSelection.ids, {
        createWritable: async (name) => {
          const fileHandle = await outputDirectory.getFileHandle(name, { create: true });
          return fileHandle.createWritable();
        },
      });
    } catch {
      // renderIds stores the user-facing error.
    }
  }, [outputDirectory, renderIds, renderSelection]);

  const stopRendering = useCallback(() => {
    runningRef.current = false;
  }, []);

  useEffect(() => {
    const rendererWindow = window as DirectoryPickerWindow;
    rendererWindow.cardNft2Renderer = {
      renderIdsToDownloads: async (ids: number[]) => {
        const normalizedIds = ids.map((id) => normalizeCardNft2CardId(id)).filter((id): id is number => Boolean(id));
        return renderIds(normalizedIds, {
          saveBlob: async (blob, name) => {
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = name;
            anchor.style.display = 'none';
            document.body.appendChild(anchor);
            anchor.click();
            document.body.removeChild(anchor);
            window.setTimeout(() => URL.revokeObjectURL(url), 5_000);
          },
        });
      },
    };
    return () => {
      if (rendererWindow.cardNft2Renderer) delete rendererWindow.cardNft2Renderer;
    };
  }, [renderIds]);

  return (
    <main className="renderer-shell">
      <section className="renderer-workspace">
        <header className="renderer-header">
          <div>
            <p className="renderer-kicker">card_nft_2</p>
            <h1>Video renderer</h1>
          </div>
          <div className="renderer-status" data-ready={imageReady ? 'true' : 'false'}>
            {running ? `Rendering ${currentCardId}` : imageReady ? `Card ${currentCardId} ready` : `Loading ${currentCardId}`}
          </div>
        </header>

        <div className="renderer-layout">
          <section className="renderer-controls" aria-label="Renderer controls">
            <div className="renderer-list-row">
              <label>
                <span>IDs</span>
                <input
                  type="text"
                  placeholder="1584,1665,2102"
                  value={idListInput}
                  disabled={running}
                  onChange={(event) => setIdListInput(event.currentTarget.value)}
                />
              </label>
            </div>

            <div className="renderer-field-row">
              <label>
                <span>Start ID</span>
                <input
                  type="number"
                  min="1"
                  max={CARD_NFT_2_MAX_CARD_ID}
                  step="1"
                  value={startIdInput}
                  disabled={running}
                  onChange={(event) => setStartIdInput(event.currentTarget.value)}
                />
              </label>
              <label>
                <span>End ID</span>
                <input
                  type="number"
                  min="1"
                  max={CARD_NFT_2_MAX_CARD_ID}
                  step="1"
                  value={endIdInput}
                  disabled={running}
                  onChange={(event) => setEndIdInput(event.currentTarget.value)}
                />
              </label>
            </div>

            <div className="renderer-folder-row">
              <button type="button" className="renderer-secondary-button" disabled={running} onClick={chooseOutputDirectory}>
                Pick output folder
              </button>
              <span>{outputDirectory?.name || 'No folder selected'}</span>
            </div>

            <div className="renderer-mode-row">
              <label className="renderer-check-row">
                <input
                  type="checkbox"
                  checked={renderOnCanvas}
                  disabled={running}
                  onChange={(event) => setRenderOnCanvas(event.currentTarget.checked)}
                />
                <span>On canvas</span>
              </label>
              {renderOnCanvas && (
                <span>
                  {ON_CANVAS_LAYOUT.outputSize.width} x {ON_CANVAS_LAYOUT.outputSize.height}
                </span>
              )}
            </div>

            <div className="renderer-action-row">
              <button type="button" className="renderer-primary-button" disabled={running || !renderSelection.valid} onClick={renderToDirectory}>
                {renderSelection.mode === 'list' ? 'Render list' : 'Render range'}
              </button>
              <button type="button" className="renderer-secondary-button" disabled={!running} onClick={stopRendering}>
                Stop after current
              </button>
              <span>{renderSelection.message}</span>
            </div>

            {lastError && <p className="renderer-error">{lastError}</p>}
          </section>

          <section className="renderer-preview-panel" aria-label="Current card preview">
            <div
              ref={previewRef}
              className={`renderer-card-preview${renderOnCanvas ? ' renderer-card-preview--canvas' : ''}`}
              style={previewStyle}
            >
              <div className="renderer-preview-card-inner">
                <WipInteractiveCard
                  key={currentCardKey}
                  card={currentCard}
                  interactive={false}
                  wakeOnInteractiveUnlock={false}
                  onImageReadyChange={handleImageReadyChange}
                  ariaLabel={`card_nft_2 ${currentCardId}`}
                  imageAlt={`card_nft_2 ${currentCardId}`}
                />
              </div>
            </div>
          </section>
        </div>
      </section>

      <section className="renderer-queue" aria-label="Render queue">
        <div className="renderer-queue-header">
          <h2>Queue</h2>
          <span>{queue.filter((entry) => entry.status === 'done').length} complete</span>
        </div>
        <div className="renderer-queue-list">
          {queue.length ? (
            queue.map((entry) => (
              <div key={entry.id} className="renderer-queue-entry" data-status={entry.status}>
                <span className="renderer-queue-id">{entry.id}</span>
                <span className="renderer-queue-status">{progressLabel(entry)}</span>
              </div>
            ))
          ) : (
            <p className="renderer-empty">Choose a range and render.</p>
          )}
        </div>
      </section>
    </main>
  );
}
