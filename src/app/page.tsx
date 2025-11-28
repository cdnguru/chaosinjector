"use client";

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';

// --- CONFIGURATION ---
const DEFAULT_TEST_DURATION_SECONDS = 60;
const PLACEHOLDER_VIDEO_URL = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';
const INVALID_VIDEO_URL = 'http://force.error.test/invalid-video-source.mp4';

type ChaosType = 'none' | '404' | 'spikey';

interface PresetConfig {
  name: string;
  description: string;
  delay: number;
  errorRate: number;
  chaosType: ChaosType;
  network?: {
    latency?: number;
    jitter?: [number, number];
    throttleBps?: number;
  };
}

const PRESETS: Record<string, PresetConfig> = {
  baseline: { name: "BASELINE (STABLE)", description: "Standard load with no injected errors. System check complete.", delay: 0, errorRate: 0.0, chaosType: 'none' },
  latency: { name: "LATENCY INJECT (1s)", description: "Simulates 1 second initial network delay. High-stress pre-buffer test.", delay: 1000, errorRate: 0.0, chaosType: 'none' },
  'high-latency': { name: "HIGH LATENCY (800ms)", description: "Consistent 800ms network latency on all requests.", delay: 0, errorRate: 0.0, chaosType: 'none', network: { latency: 800 } },
  'bouncy-latency': { name: "BOUNCY LATENCY", description: "Random latency between 150ms and 1500ms (Jitter).", delay: 0, errorRate: 0.0, chaosType: 'none', network: { jitter: [150, 1500] } },
  'throttle-1mbps': { name: "THROTTLE 1 Mbps", description: "Bandwidth limited to 1 Mbps. Forces quality drop.", delay: 0, errorRate: 0.0, chaosType: 'none', network: { throttleBps: 1000000 } },
  'throttle-3mbps': { name: "THROTTLE 3 Mbps", description: "Bandwidth limited to 3 Mbps. Mid-range constraint.", delay: 0, errorRate: 0.0, chaosType: 'none', network: { throttleBps: 3000000 } },
  'throttle-5mbps': { name: "THROTTLE 5 Mbps", description: "Bandwidth limited to 5 Mbps. High-range constraint.", delay: 0, errorRate: 0.0, chaosType: 'none', network: { throttleBps: 5000000 } },
  '404': { name: "NETWORK ERROR (10%)", description: "10% chance of a segment fault during transmission.", delay: 0, errorRate: 0.1, chaosType: '404' },
  spikey: { name: "SPIKE CHAOS", description: "Randomly injects packet drops and buffering events. High variability.", delay: 0, errorRate: 0.05, chaosType: 'spikey' }
};

interface BitrateInfo {
  bitrate: number;
  timeSpent: number;
}

interface BitratePoint {
  time: number;
  bitrate: number;
}

interface ClientInfo {
  ip: string;
  city: string;
  region: string;
  country: string;
  org: string;
}

interface Simulation {
  id: string;
  name: string;
  videoUrl: string;
  preset: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  isMinimized: boolean;
  ttff: number | null;
  rebufferingCount: number;
  rebufferingTime: number;
  errorCount: number;
  playbackPercent: number;
  startTime: number | null;
  endTime: number | null;
  totalBytes: number;
  bitrateHistory: BitrateInfo[];
  errorCodes: number[];
  testDuration: number;
  cacheBuster: string;
  droppedFrames: number;
  bufferGap: number;
  bitrateTimeline: BitratePoint[];
}

// --- UTILITY FUNCTIONS & STYLED COMPONENTS ---
/** Generates a unique ID */
const generateId = () => Math.random().toString(36).substring(2, 9);

/** Formats the duration into a readable string */
const formatDuration = (ms: number | null | undefined) => {
  if (ms === null || ms === undefined) return 'N/A';
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
};

/** Formats bytes to human readable */
const formatBytes = (bytes: number) => {
  if (bytes === 0) return { value: '0', unit: 'B' };
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return {
    value: (bytes / Math.pow(k, i)).toFixed(2),
    unit: sizes[i]
  };
};

/** Formats bitrate to Mbps */
const formatBitrate = (bps: number) => {
  return `${(bps / 1000000).toFixed(2)} Mbps`;
};

// SVG Icons for Status
const StatusIcon = ({ status }: { status: string }) => {
  const iconClass = "w-4 h-4";
  switch (status) {
    case 'completed': return <svg className={`${iconClass} text-green-400`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>;
    case 'running': return <svg className={`${iconClass} text-cyan-400 animate-spin`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 0020 8m-2-8v5h-.582m-15.356 2A8.001 8.001 0 014 16m3-3h.01"></path></svg>;
    case 'failed': return <svg className={`${iconClass} text-red-500 animate-pulse`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>;
    default: return <svg className={`${iconClass} text-gray-500`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>;
  }
};

const KpiDisplay = ({ value, label, unit = '', colorClass = 'text-cyan-400' }: { value: string | number | null, label: string, unit?: string, colorClass?: string }) => (
  <div className="flex flex-col p-3 bg-gray-800 border border-cyan-700/50 rounded-lg shadow-inner shadow-black/50 font-mono text-center">
    <span className={`text-2xl md:text-3xl font-bold ${colorClass} tracking-widest leading-none`}>
      {value !== null ? value : '---'}
    </span>
    <span className="text-xs text-gray-400 font-medium uppercase mt-1">
      {label} {unit && <span className="text-cyan-500">{unit}</span>}
    </span>
  </div>
);

// --- SHAKA PLAYER COMPONENT ---
const ShakaPlayer = React.forwardRef<HTMLVideoElement, {
  videoUrl: string;
  status: Simulation['status'];
  networkConfig?: PresetConfig['network'];
  onMetricsUpdate: (metrics: { totalBytes: number; currentBitrate: number; droppedFrames: number; bufferGap: number; time: number }) => void;
  onError: (code: number, message: string) => void;
  onPlaying: () => void;
  onWaiting: () => void;
  onCanPlay: () => void;
}>(({ videoUrl, status, networkConfig, onMetricsUpdate, onError, onPlaying, onWaiting, onCanPlay }, ref) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<any>(null);
  const metricsIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const [isClient, setIsClient] = useState(false);

  useEffect(() => {
    setIsClient(true);
  }, []);

  useEffect(() => {
    if (!isClient) return;

    const videoElement = ref as React.RefObject<HTMLVideoElement>;
    if (!videoElement.current || !containerRef.current) return;

    // Detect if URL is HLS or DASH
    const isHLS = videoUrl.includes('.m3u8');
    const isDASH = videoUrl.includes('.mpd');
    const isStreaming = isHLS || isDASH;

    if (!isStreaming) {
      // Use native video element for MP4
      if (videoElement.current) {
        videoElement.current.src = videoUrl;
        videoElement.current.load();

        // Autoplay after video can play
        const handleCanPlayThrough = () => {
          if (videoElement.current) {
            videoElement.current.play().catch(e =>
              console.log('Autoplay failed, user interaction needed.', e)
            );
          }
        };

        videoElement.current.addEventListener('canplaythrough', handleCanPlayThrough, { once: true });
      }

      // Simple metrics for native playback
      metricsIntervalRef.current = setInterval(() => {
        if (videoElement.current) {
          // Estimate bytes from buffered ranges
          const buffered = videoElement.current.buffered;
          if (buffered.length > 0) {
            const duration = videoElement.current.duration;
            const bufferedEnd = buffered.end(buffered.length - 1);
            const percentBuffered = duration > 0 ? bufferedEnd / duration : 0;

            // Rough estimate: assume 5 Mbps for HD video
            const estimatedTotalBytes = duration * 5 * 1000000 / 8;
            const downloadedBytes = estimatedTotalBytes * percentBuffered;

            onMetricsUpdate({
              totalBytes: Math.round(downloadedBytes),
              currentBitrate: 5000000, // 5 Mbps estimate
              droppedFrames: 0,
              bufferGap: 0,
              time: videoElement.current.currentTime
            });
          }
        }
      }, 1000);

      return () => {
        if (metricsIntervalRef.current) {
          clearInterval(metricsIntervalRef.current);
        }
      };
    }

    // Use Shaka Player for HLS/DASH
    let shaka: any;

    const initPlayer = async () => {
      try {
        // Dynamic import for client-side only
        shaka = (await import('shaka-player/dist/shaka-player.ui.js')).default;

        // Install polyfills
        shaka.polyfill.installAll();

        // Check browser support
        if (!shaka.Player.isBrowserSupported()) {
          console.error('Browser not supported!');
          return;
        }

        const player = new shaka.Player();
        playerRef.current = player;

        // Configure network filters for chaos injection
        if (networkConfig) {
          const networkingEngine = player.getNetworkingEngine();

          // Request Filter: Latency & Jitter
          if (networkConfig.latency || networkConfig.jitter) {
            networkingEngine.registerRequestFilter((type: any, request: any) => {
              return new Promise<void>((resolve) => {
                let delay = networkConfig.latency || 0;
                if (networkConfig.jitter) {
                  const [min, max] = networkConfig.jitter;
                  delay += Math.random() * (max - min) + min;
                }
                setTimeout(resolve, delay);
              });
            });
          }

          // Response Filter: Bandwidth Throttling
          if (networkConfig.throttleBps) {
            networkingEngine.registerResponseFilter((type: any, response: any) => {
              return new Promise<void>((resolve) => {
                const bytes = response.data.byteLength;
                const bits = bytes * 8;
                // Calculate time needed to transfer these bits at the throttled rate
                // Subtract the time it actually took (approximated as 0 for simulation or could use response.timeMs if available)
                // For simulation, we just add the full delay needed for the transfer
                const delayMs = (bits / networkConfig.throttleBps!) * 1000;
                setTimeout(resolve, delayMs);
              });
            });
          }
        }

        player.attach(videoElement.current);

        // Error handling
        player.addEventListener('error', (event: any) => {
          const error = event.detail;
          onError(error.code, error.message || 'Shaka Player Error');
        });

        // Load the manifest and autoplay
        player.load(videoUrl).then(() => {
          // Autoplay after manifest is loaded
          if (videoElement.current) {
            videoElement.current.play().catch((e: any) =>
              console.log('Autoplay failed, user interaction needed.', e)
            );
          }
        }).catch((error: any) => {
          onError(error.code || 999, error.message || 'Failed to load video');
        });

        // Metrics tracking
        metricsIntervalRef.current = setInterval(() => {
          if (player) {
            const stats = player.getStats();
            const currentBitrate = stats.streamBandwidth || 0;
            const totalBytes = stats.streamBandwidth ? (stats.streamBandwidth * stats.playTime) / 8 : 0;
            const droppedFrames = stats.droppedFrames || 0;
            const bufferGap = stats.bufferingTime || 0; // This is total buffering time, not current gap.
            // Better buffer gap calculation:
            let currentBufferGap = 0;
            if (videoElement.current) {
              const buffered = videoElement.current.buffered;
              const currentTime = videoElement.current.currentTime;
              for (let i = 0; i < buffered.length; i++) {
                if (buffered.start(i) <= currentTime && buffered.end(i) >= currentTime) {
                  currentBufferGap = buffered.end(i) - currentTime;
                  break;
                }
              }
            }

            onMetricsUpdate({
              totalBytes: Math.round(totalBytes),
              currentBitrate: Math.round(currentBitrate),
              droppedFrames: droppedFrames,
              bufferGap: parseFloat(currentBufferGap.toFixed(2)),
              time: player.getStats().playTime || 0
            });
          }
        }, 1000);
      } catch (error) {
        console.error('Failed to load Shaka Player:', error);
        onError(999, 'Failed to initialize player');
      }
    };

    initPlayer();

    return () => {
      if (metricsIntervalRef.current) {
        clearInterval(metricsIntervalRef.current);
      }
      if (playerRef.current) {
        playerRef.current.destroy();
      }
    };
  }, [videoUrl, onError, onMetricsUpdate, ref, isClient]);

  return (
    <div ref={containerRef} className="w-full h-full">
      <video
        ref={ref as React.RefObject<HTMLVideoElement>}
        controls={status !== 'pending' && status !== 'running'}
        muted
        poster="https://placehold.co/1280x720/0f172a/67e8f9?text=SYSTEM+VIDEO+FEED"
        className="w-full h-full object-cover"
        onPlaying={onPlaying}
        onWaiting={onWaiting}
        onCanPlay={onCanPlay}
      />
    </div>
  );
});

ShakaPlayer.displayName = 'ShakaPlayer';

// --- SIMULATION CARD COMPONENT ---
const SimulationCard = React.memo(({ simulation, onUpdate, onRemove }: { simulation: Simulation, onUpdate: (id: string, updates: Partial<Simulation> | ((prev: Simulation) => Partial<Simulation>)) => void, onRemove: (id: string) => void }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const rebufferingTimerRef = useRef(0);
  const ttffStartRef = useRef(0);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const chaosIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const lastBitrateRef = useRef<number>(0);
  const bitrateStartTimeRef = useRef<number>(0);

  const { id, name, preset, status, isMinimized, errorCount, rebufferingCount, rebufferingTime, ttff, playbackPercent, startTime, videoUrl, totalBytes, bitrateHistory, errorCodes, testDuration, cacheBuster, droppedFrames, bufferGap, bitrateTimeline } = simulation;
  const config = PRESETS[preset];

  // Add cache-busting parameter to video URL
  const videoUrlWithCache = useMemo(() => {
    const separator = videoUrl.includes('?') ? '&' : '?';
    return `${videoUrl}${separator}_cb=${cacheBuster}`;
  }, [videoUrl, cacheBuster]);

  const updateStatus = useCallback((newStatus: Simulation['status']) => {
    onUpdate(id, { status: newStatus });
  }, [id, onUpdate]);

  const logError = useCallback((code: number, message: string) => {
    onUpdate(id, (sim: Simulation) => {
      const newStatus = (sim.status === 'running' || sim.status === 'pending') ? 'failed' : sim.status;
      return {
        errorCount: sim.errorCount + 1,
        errorCodes: [...sim.errorCodes, code],
        status: newStatus,
      };
    });
    console.error(`[${name}] ERROR (Code ${code}): ${message}`);
  }, [id, name, onUpdate]);

  const handleRebufferingStart = useCallback(() => {
    if (rebufferingTimerRef.current === 0) {
      rebufferingTimerRef.current = performance.now();
    }
    onUpdate(id, (sim: Simulation) => ({ rebufferingCount: sim.rebufferingCount + 1 }));
  }, [id, onUpdate]);

  const handleRebufferingEnd = useCallback(() => {
    if (rebufferingTimerRef.current > 0) {
      const timeElapsed = performance.now() - rebufferingTimerRef.current;
      onUpdate(id, (sim: Simulation) => ({
        rebufferingTime: sim.rebufferingTime + (timeElapsed / 1000),
      }));
      rebufferingTimerRef.current = 0;
    }
  }, [id, onUpdate]);

  const handlePlaybackUpdate = useCallback(() => {
    const video = videoRef.current;
    if (!video || status !== 'running') return;

    const currentTestTime = performance.now() - (startTime || 0);
    const percent = Math.min(100, (currentTestTime / (testDuration * 1000)) * 100);

    onUpdate(id, { playbackPercent: parseFloat(percent.toFixed(1)) });
  }, [id, status, startTime, onUpdate]);

  const handleInitialPlay = useCallback(() => {
    if (ttffStartRef.current > 0) {
      const timeToFirstFrame = performance.now() - ttffStartRef.current;
      onUpdate(id, { ttff: parseFloat(timeToFirstFrame.toFixed(2)) });
      ttffStartRef.current = 0;
      updateStatus('running');
      bitrateStartTimeRef.current = performance.now();
    }
    handleRebufferingEnd();
  }, [id, onUpdate, updateStatus, handleRebufferingEnd]);

  const handleMetricsUpdate = useCallback((metrics: { totalBytes: number; currentBitrate: number; droppedFrames: number; bufferGap: number; time: number }) => {
    onUpdate(id, (sim: Simulation) => {
      const newHistory = [...sim.bitrateHistory];

      if (metrics.currentBitrate !== lastBitrateRef.current && lastBitrateRef.current > 0) {
        const timeSpent = (performance.now() - bitrateStartTimeRef.current) / 1000;
        newHistory.push({
          bitrate: lastBitrateRef.current,
          timeSpent: timeSpent
        });
        bitrateStartTimeRef.current = performance.now();
      }

      lastBitrateRef.current = metrics.currentBitrate;

      // Update bitrate timeline
      let newTimeline = sim.bitrateTimeline;
      if (metrics.time > 0) {
        // Only add point if it's new or significantly different time
        const lastPoint = newTimeline[newTimeline.length - 1];
        if (!lastPoint || (metrics.time - lastPoint.time > 1) || (lastPoint.bitrate !== metrics.currentBitrate)) {
          newTimeline = [...newTimeline, { time: metrics.time, bitrate: metrics.currentBitrate }];
        }
      }

      return {
        totalBytes: metrics.totalBytes,
        droppedFrames: metrics.droppedFrames,
        bufferGap: metrics.bufferGap,
        bitrateTimeline: newTimeline
      };
    });
  }, [id, onUpdate]);

  const injectChaos = useCallback(() => {
    if (Math.random() < config.errorRate) {
      console.warn(`[${name}] Chaos injected: Forcing error by setting invalid source.`);
      const video = videoRef.current;
      if (video) {
        video.src = INVALID_VIDEO_URL + '?r=' + generateId();
        video.load();

        setTimeout(() => {
          video.src = videoUrl;
          video.load();
          if (video.paused) {
            video.play().catch(e => console.log('Could not auto-play after chaos recovery', e));
          }
        }, 500);
      }
    }
  }, [config.errorRate, name, videoUrl]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (status === 'pending') {
      if (startTime === null) {
        onUpdate(id, { startTime: performance.now() });
        ttffStartRef.current = performance.now();
        // Player component will handle playback after loading
      }
    }

    if (status === 'running') {
      intervalRef.current = setInterval(handlePlaybackUpdate, 250);

      const timeoutId = setTimeout(() => {
        if (intervalRef.current) clearInterval(intervalRef.current);
        if (chaosIntervalRef.current) {
          clearInterval(chaosIntervalRef.current);
        }
        if (video) {
          video.pause();
        }

        // Save final bitrate
        if (lastBitrateRef.current > 0) {
          const timeSpent = (performance.now() - bitrateStartTimeRef.current) / 1000;
          onUpdate(id, (sim: Simulation) => ({
            status: 'completed',
            endTime: performance.now(),
            playbackPercent: 100,
            bitrateHistory: [...sim.bitrateHistory, {
              bitrate: lastBitrateRef.current,
              timeSpent: timeSpent
            }]
          }));
        } else {
          onUpdate(id, {
            status: 'completed',
            endTime: performance.now(),
            playbackPercent: 100,
          });
        }
      }, testDuration * 1000 + config.delay);

      if (config.chaosType === '404' || config.chaosType === 'spikey') {
        chaosIntervalRef.current = setInterval(injectChaos, 3000);
      }

      return () => {
        clearTimeout(timeoutId);
      };
    }

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (chaosIntervalRef.current) clearInterval(chaosIntervalRef.current);
    };

  }, [status, config, handlePlaybackUpdate, injectChaos, onUpdate, id, name, startTime]);

  const statusClasses = useMemo(() => {
    switch (status) {
      case 'completed': return 'bg-green-700 shadow-green-900/50 text-green-300';
      case 'running': return 'bg-cyan-700 shadow-cyan-900/50 text-cyan-300 animate-pulse';
      case 'failed': return 'bg-red-700 shadow-red-900/50 text-red-300 animate-pulse';
      default: return 'bg-gray-700 shadow-gray-900/50 text-gray-400';
    }
  }, [status]);

  const isFinished = status === 'completed' || status === 'failed';
  const progressColor = errorCount > 0 ? 'bg-red-500 shadow-red-500/50' : 'bg-cyan-500 shadow-cyan-500/50';

  const handleRerun = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onUpdate(id, {
      status: 'pending',
      ttff: null,
      rebufferingCount: 0,
      rebufferingTime: 0,
      errorCount: 0,
      playbackPercent: 0,
      startTime: null,
      endTime: null,
      totalBytes: 0,
      bitrateHistory: [],
      errorCodes: [],
      cacheBuster: Date.now().toString()
    });
  }, [id, onUpdate]);

  const renderMinimized = () => (
    <div
      className="flex items-center justify-between p-3 bg-gray-900 border-b border-cyan-800/50 hover:bg-gray-800 transition duration-150 cursor-pointer text-white font-mono"
      onClick={() => onUpdate(id, { isMinimized: false })}
    >
      <div className="flex items-center space-x-3 w-5/12">
        {isFinished && (
          <button
            onClick={handleRerun}
            className="p-1.5 text-green-400 hover:text-white hover:bg-green-800/30 rounded-full transition border border-green-700/50 shadow-md shadow-green-900/50"
            title="RERUN TEST"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>
          </button>
        )}
        <StatusIcon status={status} />
        <span className={`px-2 py-0.5 text-xs font-bold rounded-sm uppercase tracking-widest ${statusClasses}`}>
          {status}
        </span>
        <div className="flex flex-col">
          <span className="font-semibold text-gray-200 truncate text-sm">{name}</span>
          <span className="text-xs text-gray-500">
            Duration: {testDuration}s | Delay: {config.delay}ms | Error Rate: {(config.errorRate * 100).toFixed(0)}%
            {errorCodes.length > 0 && ` | Codes: ${errorCodes.join(', ')}`}
          </span>
        </div>
      </div>

      <div className="flex flex-1 justify-between text-center text-xs ml-4">
        <div className="flex-1 min-w-0">
          <span className="font-bold text-cyan-400">{ttff !== null ? `${ttff.toFixed(0)}` : '---'}</span>
          <span className="text-xs text-gray-500 block">TTFF</span>
        </div>
        <div className="flex-1 min-w-0">
          <span className="font-bold text-cyan-400">{rebufferingCount}</span>
          <span className="text-xs text-gray-500 block">Rebuffers</span>
        </div>
        <div className="flex-1 min-w-0">
          <span className="font-bold text-cyan-400">{formatBytes(totalBytes).value}</span>
          <span className="text-xs text-gray-500 block">Downloaded {formatBytes(totalBytes).unit}</span>
        </div>
        <div className="flex-1 min-w-0">
          <span className={`font-bold ${errorCount > 0 ? 'text-red-500' : 'text-cyan-400'}`}>{errorCount}</span>
          <span className="text-xs text-gray-500 block">Errors</span>
        </div>
        <div className="flex-1 min-w-0">
          <span className={`font-bold text-lg ${errorCount > 0 ? 'text-red-500' : 'text-green-400'}`}>{playbackPercent.toFixed(1)}%</span>
        </div>
      </div>
      <div className="flex flex-1 justify-between text-center text-xs ml-4 mt-2 border-t border-cyan-900/30 pt-2">
        <div className="flex-1 min-w-0">
          <span className="font-bold text-cyan-400">{droppedFrames}</span>
          <span className="text-xs text-gray-500 block">Dropped</span>
        </div>
        <div className="flex-1 min-w-0">
          <span className="font-bold text-cyan-400">{bufferGap.toFixed(1)}s</span>
          <span className="text-xs text-gray-500 block">Buffer</span>
        </div>
      </div>
    </div>
  );

  const BitrateChart = ({ data }: { data: BitratePoint[] }) => {
    if (data.length === 0) return <div className="h-full flex items-center justify-center text-gray-500 text-xs">NO DATA</div>;

    // Format data for chart - convert bps to Mbps
    const chartData = data.map(d => ({
      time: d.time,
      bitrate: parseFloat((d.bitrate / 1000000).toFixed(2))
    }));

    return (
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
          <XAxis
            dataKey="time"
            type="number"
            domain={['dataMin', 'dataMax']}
            tick={{ fill: '#94a3b8', fontSize: 10 }}
            tickFormatter={(val) => val.toFixed(0) + 's'}
          />
          <YAxis
            tick={{ fill: '#94a3b8', fontSize: 10 }}
            tickFormatter={(val) => val + 'M'}
            domain={[0, 'auto']}
          />
          <Tooltip
            contentStyle={{ backgroundColor: '#0f172a', borderColor: '#0891b2', fontSize: '12px' }}
            itemStyle={{ color: '#22d3ee' }}
            formatter={(value: number) => [`${value} Mbps`, 'Bitrate']}
            labelFormatter={(label: number) => `Time: ${label.toFixed(1)}s`}
          />
          <Line
            type="stepAfter"
            dataKey="bitrate"
            stroke="#22d3ee"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4, fill: '#22d3ee' }}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    );
  };

  const renderDetailed = () => (
    <div className="w-full mb-6 bg-gray-900 rounded-xl shadow-2xl shadow-cyan-900/20 border border-cyan-800/50 p-6 font-mono text-gray-200">
      <div className="flex justify-between items-start border-b border-cyan-700/50 pb-4 mb-4">
        <div>
          <h2 className="text-3xl font-bold text-cyan-400 uppercase tracking-widest">{name}</h2>
          <p className="text-sm text-gray-400 mt-1">{config.description}</p>
          <div className="flex items-center mt-2 space-x-3">
            <StatusIcon status={status} />
            <span className={`text-sm font-semibold rounded-sm px-3 py-0.5 uppercase tracking-wider ${statusClasses}`}>
              {status}
            </span>
            <span className="text-sm text-gray-500 font-medium">
              RUNTIME: {isFinished ? formatDuration(testDuration * 1000) : formatDuration(testDuration * 1000)}
            </span>
          </div>
        </div>
        <div className="flex space-x-2">
          <button
            onClick={() => onUpdate(id, { isMinimized: true })}
            className="p-2 text-cyan-400 hover:text-white hover:bg-cyan-800/30 rounded-full transition border border-cyan-700/50 shadow-md shadow-cyan-900/50"
            title="MINIMIZE SYSTEM"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M20 12H4"></path></svg>
          </button>
          <button
            onClick={() => onRemove(id)}
            className="p-2 text-red-500 hover:text-white hover:bg-red-800/30 rounded-full transition border border-red-700/50 shadow-md shadow-red-900/50"
            title="PURGE DATA"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-6 gap-4 mb-6">
        <KpiDisplay
          value={ttff !== null ? `${ttff.toFixed(0)}` : 'INIT'}
          unit="ms"
          label="TTFF"
        />
        <KpiDisplay
          value={rebufferingCount}
          label="REBUFFERS"
          colorClass={rebufferingCount > 0 ? 'text-yellow-400' : 'text-cyan-400'}
        />
        <KpiDisplay
          value={rebufferingTime.toFixed(2)}
          unit="s"
          label="REBUFFER TIME"
          colorClass={rebufferingTime > 0 ? 'text-yellow-400' : 'text-cyan-400'}
        />
        <KpiDisplay
          value={errorCount}
          label="FAULTS"
          colorClass={errorCount > 0 ? 'text-red-500 animate-pulse' : 'text-cyan-400'}
        />
        <KpiDisplay
          value={formatBytes(totalBytes).value}
          unit={formatBytes(totalBytes).unit}
          label="DOWNLOADED"
        />
        <KpiDisplay
          value={droppedFrames}
          label="DROPPED FRAMES"
          colorClass={droppedFrames > 0 ? 'text-yellow-400' : 'text-cyan-400'}
        />
        <KpiDisplay
          value={bufferGap.toFixed(2)}
          unit="s"
          label="BUFFER HEALTH"
          colorClass={bufferGap < 2 ? 'text-red-400' : 'text-cyan-400'}
        />
        <KpiDisplay
          value={playbackPercent.toFixed(1)}
          unit="%"
          label="PROGRESS"
          colorClass={'text-green-400'}
        />
      </div>



      {bitrateTimeline.length > 0 && (
        <div className="mt-6 p-4 bg-gray-800 rounded-lg border border-cyan-900/30">
          <h3 className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-3">Bitrate Timeline</h3>
          <div className="h-40 w-full">
            <BitrateChart data={bitrateTimeline} />
          </div>
        </div>
      )}

      <div className="relative mb-6 rounded-lg overflow-hidden shadow-2xl shadow-black/50 border-2 border-cyan-900/50 aspect-video">
        <ShakaPlayer
          ref={videoRef}
          videoUrl={videoUrlWithCache}
          status={status}
          networkConfig={config.network}
          onMetricsUpdate={handleMetricsUpdate}
          onError={logError}
          onPlaying={handleInitialPlay}
          onWaiting={handleRebufferingStart}
          onCanPlay={handleRebufferingEnd}
        />
        {status === 'pending' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black bg-opacity-90 text-cyan-400 font-mono text-xl p-4">
            <p className="p-3 border-2 border-cyan-500 rounded-lg animate-pulse tracking-widest">
              [ BOOT SEQUENCE ACTIVE ]
            </p>
            <p className="mt-2 text-sm text-gray-500">INIT DELAY: {config.delay}ms. Awaiting primary data stream...</p>
          </div>
        )}
      </div>

      <div className="w-full bg-gray-700 rounded-full h-3 mt-4 overflow-hidden border border-cyan-800/50">
        <div
          className={`h-3 rounded-full transition-all duration-300 ease-out ${progressColor} shadow-lg`}
          style={{ width: `${playbackPercent}%` }}
        ></div>
      </div>
      <p className="mt-2 text-xs text-gray-500 text-right uppercase">
        Data Stream Integrity: <span className="font-bold text-cyan-400 tracking-wider">{playbackPercent.toFixed(1)}%</span> complete
      </p>
    </div>
  );

  return (
    <div className="w-full transition-all duration-300 ease-in-out">
      {isMinimized ? renderMinimized() : renderDetailed()}
    </div>
  );
});

SimulationCard.displayName = 'SimulationCard';

// --- CREATION MODAL COMPONENT ---
const SimulationCreator = ({ videoUrl, onCreate, setVideoUrl, clientInfo }: { videoUrl: string, onCreate: (sim: Simulation) => void, setVideoUrl: (url: string) => void, clientInfo: ClientInfo | null }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [selectedPreset, setSelectedPreset] = useState('baseline');
  const [customName, setCustomName] = useState('');
  const [testDuration, setTestDuration] = useState(DEFAULT_TEST_DURATION_SECONDS);

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    const presetConfig = PRESETS[selectedPreset];
    const newSim: Simulation = {
      id: generateId(),
      name: customName || presetConfig.name + ' TEST',
      videoUrl: videoUrl,
      preset: selectedPreset,
      status: 'pending',
      isMinimized: false,
      ttff: null,
      rebufferingCount: 0,
      rebufferingTime: 0,
      errorCount: 0,
      playbackPercent: 0,
      startTime: null,
      endTime: null,
      totalBytes: 0,
      bitrateHistory: [],
      errorCodes: [],
      testDuration: testDuration,
      cacheBuster: Date.now().toString(),
      droppedFrames: 0,
      bufferGap: 0,
      bitrateTimeline: []
    };
    onCreate(newSim);
    setIsOpen(false);
    setCustomName('');
  };

  if (!isOpen) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        className="flex items-center justify-center p-3 h-14 w-full sm:w-1/2 lg:w-1/4 bg-cyan-600 hover:bg-cyan-500 text-gray-900 font-extrabold rounded-lg shadow-2xl shadow-cyan-500/50 transition duration-200 transform hover:scale-[1.01] uppercase tracking-widest border-2 border-cyan-400"
      >
        <svg className="w-6 h-6 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 6v6m0 0v6m0-6h6m-6 0H6"></path></svg>
        Activate New Simulation
      </button>
    );
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-90 flex items-center justify-center z-50 p-4 font-mono">
      <div className="bg-gray-900 p-8 rounded-xl shadow-3xl w-full max-w-lg border-2 border-cyan-500/50">
        <h2 className="text-2xl font-bold text-cyan-400 mb-6 border-b border-cyan-700/50 pb-2 uppercase tracking-widest">Simulation Parameter Input</h2>

        {clientInfo && (
          <div className="mb-4 p-3 bg-gray-800 border border-cyan-700/50 rounded-lg text-xs">
            <div className="font-bold text-cyan-400 mb-1">CLIENT INFO</div>
            <div className="text-gray-400">
              <div>IP: {clientInfo.ip}</div>
              <div>Location: {clientInfo.city}, {clientInfo.region}, {clientInfo.country}</div>
              <div>ISP: {clientInfo.org}</div>
            </div>
          </div>
        )}

        <form onSubmit={handleCreate}>
          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-400 mb-1">Video URL (HLS/DASH/MP4)</label>
            <input
              type="url"
              value={videoUrl}
              onChange={(e) => setVideoUrl(e.target.value)}
              className="mt-1 block w-full bg-gray-800 border border-cyan-700/50 text-cyan-400 rounded-md shadow-inner p-3 focus:ring-cyan-500 focus:border-cyan-500"
              placeholder={PLACEHOLDER_VIDEO_URL}
            />
            <p className="text-xs text-gray-600 mt-1">Supports HLS (.m3u8), DASH (.mpd), and MP4 streams.</p>
          </div>
          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-400 mb-1">Test Designation</label>
            <input
              type="text"
              value={customName}
              onChange={(e) => setCustomName(e.target.value)}
              className="mt-1 block w-full bg-gray-800 border border-cyan-700/50 text-cyan-400 rounded-md shadow-inner p-3"
              placeholder={PRESETS[selectedPreset].name + ' TEST'}
            />
          </div>
          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-400 mb-1">Test Duration (seconds)</label>
            <input
              type="number"
              value={testDuration}
              onChange={(e) => setTestDuration(parseInt(e.target.value) || DEFAULT_TEST_DURATION_SECONDS)}
              min="10"
              max="600"
              className="mt-1 block w-full bg-gray-800 border border-cyan-700/50 text-cyan-400 rounded-md shadow-inner p-3"
            />
            <p className="text-xs text-gray-600 mt-1">Duration of the test in seconds (10-600).</p>
          </div>
          <div className="mb-6">
            <label className="block text-sm font-medium text-gray-400 mb-1">Select Chaos Protocol</label>
            <select
              value={selectedPreset}
              onChange={(e) => setSelectedPreset(e.target.value)}
              className="mt-1 block w-full bg-gray-800 border border-cyan-700/50 text-cyan-400 rounded-md shadow-inner p-3 focus:ring-cyan-500 focus:border-cyan-500"
              required
            >
              {Object.entries(PRESETS).map(([key, config]) => (
                <option key={key} value={key} className="bg-gray-900 text-gray-200">
                  {config.name} | {config.description}
                </option>
              ))}
            </select>
          </div>
          <div className="flex justify-end space-x-3">
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              className="px-6 py-2 text-gray-400 bg-gray-800 rounded-lg hover:bg-gray-700 transition font-medium border border-gray-700/50"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-6 py-2 bg-cyan-600 text-gray-900 rounded-lg hover:bg-cyan-500 transition font-extrabold shadow-md shadow-cyan-500/50 uppercase tracking-widest"
            >
              Execute Test Protocol
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

// --- MAIN APP COMPONENT ---
export default function App() {
  const [simulations, setSimulations] = useState<Simulation[]>([]);
  const [videoUrl, setVideoUrl] = useState(PLACEHOLDER_VIDEO_URL);
  const [clientInfo, setClientInfo] = useState<ClientInfo | null>(null);

  useEffect(() => {
    // Fetch client info
    fetch('https://ipapi.co/json/')
      .then(res => res.json())
      .then(data => {
        setClientInfo({
          ip: data.ip || 'Unknown',
          city: data.city || 'Unknown',
          region: data.region || 'Unknown',
          country: data.country_name || 'Unknown',
          org: data.org || 'Unknown ISP'
        });
      })
      .catch(err => console.error('Failed to fetch client info:', err));
  }, []);

  useEffect(() => {
    if (simulations.length === 0) {
      setSimulations([{
        id: generateId(),
        name: PRESETS.baseline.name + ' (INITIAL CHECK)',
        videoUrl: PLACEHOLDER_VIDEO_URL,
        preset: 'baseline',
        status: 'pending',
        isMinimized: false,
        ttff: null,
        rebufferingCount: 0,
        rebufferingTime: 0,
        errorCount: 0,
        playbackPercent: 0,
        startTime: null,
        endTime: null,
        totalBytes: 0,
        bitrateHistory: [],
        errorCodes: [],
        testDuration: DEFAULT_TEST_DURATION_SECONDS,
        cacheBuster: Date.now().toString(),
        droppedFrames: 0,
        bufferGap: 0,
        bitrateTimeline: []
      }]);
    }
  }, [simulations.length]);

  const handleCreateSimulation = (newSim: Simulation) => {
    setSimulations(prev => [...prev, newSim]);
  };

  const handleUpdateSimulation = useCallback((id: string, updates: Partial<Simulation> | ((prev: Simulation) => Partial<Simulation>)) => {
    setSimulations(prev =>
      prev.map(sim =>
        sim.id === id
          ? { ...sim, ...(typeof updates === 'function' ? updates(sim) : updates) }
          : sim
      )
    );
  }, []);

  const handleRemoveSimulation = useCallback((id: string) => {
    setSimulations(prev => prev.filter(sim => sim.id !== id));
  }, []);

  const minimizedSimulations = simulations.filter(s => s.isMinimized);
  const activeSimulations = simulations.filter(s => !s.isMinimized);

  return (
    <div className="min-h-screen bg-gray-900 text-gray-200 p-4 md:p-8 font-mono">
      <header className="max-w-7xl mx-auto mb-8 border-b border-cyan-700/50 pb-4">
        <h1 className="text-4xl font-extrabold text-cyan-400 mb-2 uppercase tracking-widest drop-shadow-lg shadow-cyan-400">
          <span className="text-gray-500 mr-2">[//]</span> OPERATION: MEDIA STABILITY
        </h1>
        <p className="text-gray-500 text-sm">ENGAGED: Real-time network chaos simulation with adaptive bitrate testing.</p>
        {clientInfo && (
          <p className="mt-2 text-xs text-gray-600">
            CLIENT: {clientInfo.ip} | {clientInfo.city}, {clientInfo.country} | {clientInfo.org}
          </p>
        )}
      </header>

      <main className="max-w-7xl mx-auto">
        <div className="mb-8">
          <SimulationCreator
            videoUrl={videoUrl}
            setVideoUrl={setVideoUrl}
            onCreate={handleCreateSimulation}
            clientInfo={clientInfo}
          />
        </div>

        {minimizedSimulations.length > 0 && (
          <div className="mb-8 bg-gray-900 rounded-xl shadow-2xl shadow-cyan-900/20 border border-cyan-700/50 overflow-hidden">
            <h2 className="text-xl font-bold text-cyan-400 p-4 bg-gray-800 border-b border-cyan-700/50 uppercase tracking-wider">
              <span className="text-gray-500 mr-2">[ CONSOLE ]</span> COMPARISON LOG ({minimizedSimulations.length} Pinned)
            </h2>
            <div className="space-y-0 divide-y divide-cyan-900/50">
              {minimizedSimulations.map(sim => (
                <SimulationCard
                  key={sim.id}
                  simulation={sim}
                  onUpdate={handleUpdateSimulation}
                  onRemove={handleRemoveSimulation}
                />
              ))}
            </div>
          </div>
        )}

        <div className="space-y-6">
          {activeSimulations.length > 0 && (
            <h2 className="text-xl font-bold text-gray-400 mt-4 uppercase tracking-wider">
              <span className="text-gray-500 mr-2">[ ACTIVE ]</span> DETAILED FEED
            </h2>
          )}
          {activeSimulations.map(sim => (
            <SimulationCard
              key={sim.id}
              simulation={sim}
              onUpdate={handleUpdateSimulation}
              onRemove={handleRemoveSimulation}
            />
          ))}
        </div>

        {simulations.length === 0 && (
          <div className="p-10 text-center bg-gray-800 rounded-lg shadow-md border border-cyan-700/50">
            <p className="text-gray-500 text-lg uppercase tracking-widest">
              [ SYSTEM IDLE ] Awaiting new test protocol.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
