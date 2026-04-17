import React, { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Skull, 
  Eye, 
  Map as MapIcon, 
  Key, 
  Timer, 
  Ghost,
  Volume2,
  VolumeX,
  Play,
  RotateCcw,
  DoorOpen,
  ArrowRight,
  Move,
  Footprints,
  Activity,
  Lock,
  Search
} from 'lucide-react';

// --- Constants & Types ---
const CANVAS_WIDTH = 800;
const CANVAS_HEIGHT = 600;
const PLAYER_SPEED = 4.0;
const PLAYER_RUN_SPEED = 7.5;
const GREENI_BASE_SPEED = 1.8;
const NOISE_RADIUS_WALK = 0;
const NOISE_RADIUS_RUN = 150;
const VISION_REVEAL_RADIUS = 2000; // Increased for full visibility

type Point = { x: number; y: number };
type GameState = 'intro' | 'playing' | 'jumpscare' | 'gameover' | 'escaped' | 'day_transition';

interface Wall {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface HidingSpot {
  x: number;
  y: number;
  w: number;
  h: number;
  type: 'bed' | 'closet';
}

interface Door {
  x: number;
  y: number;
  w: number;
  h: number;
  isOpen: boolean;
  name: string;
}

type Greeni = Point & { 
  id: number;
  angle: number; 
  state: 'patrol' | 'chase' | 'investigate'; 
  target: Point;
  patrolIndex: number;
  shoutTimer: number;
};

// --- House Map Data ---
const WALLS: Wall[] = [
  // Outer walls
  { x: 0, y: 0, w: 800, h: 20 },
  { x: 0, y: 580, w: 800, h: 20 },
  { x: 0, y: 20, w: 20, h: 560 },
  { x: 780, y: 20, w: 20, h: 560 },
  // Interior Rooms
  { x: 200, y: 20, w: 20, h: 200 }, // Wall 1
  { x: 20, y: 220, w: 100, h: 20 }, // Wall 2
  { x: 220, y: 220, w: 100, h: 20 }, // Wall 3 (Doorway between)
  { x: 400, y: 150, w: 20, h: 300 }, // Wall 4
  { x: 420, y: 150, w: 200, h: 20 }, // Wall 5
  { x: 620, y: 150, w: 20, h: 250 }, // Wall 6
  { x: 400, y: 450, w: 200, h: 20 }, // Wall 7
];

const DOORS = [
  { x: 120, y: 220, w: 100, h: 20 }, // Door 1
  { x: 400, y: 150, w: 20, h: 60, isOpen: true }, // Door 2
  { x: 300, y: 450, w: 100, h: 20 }, // Door 3
];

const HIDING_SPOTS: HidingSpot[] = [
  { x: 50, y: 50, w: 80, h: 120, type: 'bed' },
  { x: 700, y: 450, w: 50, h: 100, type: 'closet' },
  { x: 450, y: 200, w: 100, h: 60, type: 'bed' },
];

// --- Helpers ---
const getRandomInt = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;

export default function App() {
  const [gameState, setGameState] = useState<GameState>('intro');
  const [day, setDay] = useState(1);
  const [numKeysCollected, setNumKeysCollected] = useState(0);
  const [noiseLevel, setNoiseLevel] = useState(0);
  const [isHiding, setIsHiding] = useState(false);
  const [isAudioOn, setIsAudioOn] = useState(true);
  const [flash, setFlash] = useState(0); // 0-1 for screen flashes
  const [stamina, setStamina] = useState(100);
  const [interactPrompt, setInteractPrompt] = useState<string | null>(null);
  const [showStage2, setShowStage2] = useState(false);

  const startGame = () => {
    initAudio();
    resetPositions();
    setGameState('playing');
    setDay(1);
  };

  // Refs for high-perf game loop
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const playerRef = useRef<Point & { angle: number }>({ x: 100, y: 100, angle: 0 });
  const greenisRef = useRef<Greeni[]>([]);
  const keysRef = useRef<Point[]>([]);
  const doorsRef = useRef<Door[]>([
    { x: 120, y: 220, w: 100, h: 20, isOpen: false, name: 'Bosh xona eshigi' },
    { x: 400, y: 150, w: 20, h: 60, isOpen: false, name: 'Yotoqxona eshigi' },
    { x: 300, y: 450, w: 100, h: 20, isOpen: false, name: 'Chiqish yo\'lagi eshigi' },
  ]);
  const exitRef = useRef<Point & { w: number; h: number }>({ x: 750, y: 280, w: 30, h: 60 });
  const keysDown = useRef<Set<string>>(new Set());
  const patrolPoints = useRef<Point[]>([
    { x: 100, y: 100 }, // Start area
    { x: 400, y: 100 }, 
    { x: 700, y: 100 }, 
    { x: 700, y: 280 }, // Near Exit Gate
    { x: 700, y: 500 }, 
    { x: 400, y: 500 },
    { x: 100, y: 500 },
    { x: 120, y: 300 }, // Central corridor
    { x: 400, y: 300 }, // Key area
    { x: 600, y: 300 },
  ]);
  const currentPatrolIndex = useRef(0);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const heartbeatOscRef = useRef<OscillatorNode | null>(null);

  // --- Audio Synthesis ---
  const initAudio = () => {
    if (!audioCtxRef.current) {
      audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    if (audioCtxRef.current.state === 'suspended') {
      audioCtxRef.current.resume();
    }
  };

  const playHeartbeat = (dist: number) => {
    if (!isAudioOn || !audioCtxRef.current) return;
    const intensity = Math.max(0, 1 - dist / 500);
    if (intensity < 0.1) return;

    const osc = audioCtxRef.current.createOscillator();
    const gain = audioCtxRef.current.createGain();
    
    osc.type = 'sine';
    osc.frequency.setValueAtTime(60, audioCtxRef.current.currentTime);
    osc.frequency.exponentialRampToValueAtTime(30, audioCtxRef.current.currentTime + 0.1);
    
    gain.gain.setValueAtTime(0.5 * intensity, audioCtxRef.current.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, audioCtxRef.current.currentTime + 0.1);
    
    osc.connect(gain);
    gain.connect(audioCtxRef.current.destination);
    
    osc.start();
    osc.stop(audioCtxRef.current.currentTime + 0.1);
  };

  const playShout = () => {
    if (!isAudioOn || !audioCtxRef.current) return;
    const ctx = audioCtxRef.current;
    
    // Create a scary distorted "I SEE YOU" sound using oscillators
    const osc1 = ctx.createOscillator();
    const gain = ctx.createGain();
    
    osc1.type = 'sawtooth';
    osc1.frequency.setValueAtTime(200, ctx.currentTime);
    osc1.frequency.exponentialRampToValueAtTime(50, ctx.currentTime + 0.5);
    
    // Add LFO for "screeching" effect
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    lfo.frequency.value = 30;
    lfoGain.gain.value = 100;
    lfo.connect(lfoGain);
    lfoGain.connect(osc1.frequency);
    
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5);
    
    osc1.connect(gain);
    gain.connect(ctx.destination);
    
    lfo.start();
    osc1.start();
    lfo.stop(ctx.currentTime + 0.5);
    osc1.stop(ctx.currentTime + 0.5);
  };

  // --- Game Mechanics ---

  const checkCollision = (x: number, y: number, radius: number = 10) => {
    // Check walls
    for (const wall of WALLS) {
      if (x + radius > wall.x && x - radius < wall.x + wall.w &&
          y + radius > wall.y && y - radius < wall.y + wall.h) {
        return true;
      }
    }
    // Check doors
    for (const door of doorsRef.current) {
      if (!door.isOpen) {
        if (x + radius > door.x && x - radius < door.x + door.w &&
            y + radius > door.y && y - radius < door.y + door.h) {
          return true;
        }
      }
    }
    return false;
  };

  const handleJumpscare = () => {
    setGameState('jumpscare');
    setFlash(1);
    setTimeout(() => {
      if (day < 5) {
        setDay(d => d + 1);
        setGameState('day_transition');
        resetPositions();
        setTimeout(() => setGameState('playing'), 1200);
      } else {
        setGameState('gameover');
      }
    }, 1500);
  };

  const resetPositions = () => {
    playerRef.current = { x: 100, y: 100, angle: 0 };
    greenisRef.current = [
      { id: 1, x: 700, y: 500, angle: 0, state: 'patrol', target: patrolPoints.current[0], patrolIndex: 0, shoutTimer: 0 }
    ];
    keysRef.current = [
      { x: 550, y: 120 } // First key location
    ];
    doorsRef.current.forEach(d => d.isOpen = false);
    setNumKeysCollected(0);
    setShowStage2(false);
    setIsHiding(false);
    setStamina(100);
  };

  // --- Main Update Loop ---
  useEffect(() => {
    if (gameState !== 'playing') return;

    let lastTime = 0;
    let heartbeatTimer = 0;

    const update = (time: number) => {
      const dt = time - lastTime;
      lastTime = time;

      const ctx = canvasRef.current?.getContext('2d');
      if (!ctx) return;

      // 1. Player Movement
      if (!isHiding) {
        let dx = 0;
        let dy = 0;
        const isRunning = keysDown.current.has('Shift') && stamina > 0;
        const currentSpeed = isRunning ? PLAYER_RUN_SPEED : PLAYER_SPEED;

        if (keysDown.current.has('w')) dy -= currentSpeed;
        if (keysDown.current.has('s')) dy += currentSpeed;
        if (keysDown.current.has('a')) dx -= currentSpeed;
        if (keysDown.current.has('d')) dx += currentSpeed;

        if (dx !== 0 || dy !== 0) {
          const nextX = playerRef.current.x + dx;
          const nextY = playerRef.current.y + dy;
          
          if (!checkCollision(nextX, playerRef.current.y)) playerRef.current.x = nextX;
          if (!checkCollision(playerRef.current.x, nextY)) playerRef.current.y = nextY;
          
          playerRef.current.angle = Math.atan2(dy, dx);
          
          if (isRunning) {
            setStamina(s => Math.max(0, s - 0.5));
            setNoiseLevel(1);
          } else {
            setNoiseLevel(0.2);
            setStamina(s => Math.min(100, s + 0.2));
          }
        } else {
          setNoiseLevel(0);
          setStamina(s => Math.min(100, s + 0.5));
        }

        // Interaction logic (Doors)
        let foundNearbyDoor = false;
        for (const door of doorsRef.current) {
          const dist = Math.sqrt((playerRef.current.x - (door.x + door.w/2))**2 + (playerRef.current.y - (door.y + door.h/2))**2);
          if (dist < 60) {
            setInteractPrompt(`[K] - ${door.isOpen ? 'Eshikni yopish' : 'Eshikni ochish'}`);
            if (keysDown.current.has('k')) {
              door.isOpen = !door.isOpen;
              keysDown.current.delete('k'); // Prevent rapid toggling
              setFlash(0.1);
              setTimeout(() => setFlash(0), 50);
            }
            foundNearbyDoor = true;
            break;
          }
        }
        if (!foundNearbyDoor) setInteractPrompt(null);

        // Hiding logic
        if (keysDown.current.has(' ')) {
          for (const spot of HIDING_SPOTS) {
            const dist = Math.sqrt((playerRef.current.x - (spot.x + spot.w/2))**2 + (playerRef.current.y - (spot.y + spot.h/2))**2);
            if (dist < 40) {
              setIsHiding(true);
              keysDown.current.delete(' ');
              break;
            }
          }
        }
      } else {
        if (keysDown.current.has('w') || keysDown.current.has('s') || keysDown.current.has('a') || keysDown.current.has('d')) {
          setIsHiding(false);
        }
      }

      // 2. Greenis AI Logic
      let minGreediDist = Infinity;
      
      greenisRef.current.forEach(greeni => {
        const distToPlayer = Math.sqrt((greeni.x - playerRef.current.x)**2 + (greeni.y - playerRef.current.y)**2);
        minGreediDist = Math.min(minGreediDist, distToPlayer);

        // Detection
        const canSee = distToPlayer < 300 && !isHiding;
        const canHear = noiseLevel > 0.5 && distToPlayer < 400;

        if (canSee) {
          if (greeni.state !== 'chase') {
            greeni.shoutTimer = 2000; // Shout duration for UI
            playShout(); // Trigger sound
          }
          greeni.state = 'chase';
          greeni.target = { x: playerRef.current.x, y: playerRef.current.y };
        } else if (canHear) {
          greeni.state = 'investigate';
          greeni.target = { x: playerRef.current.x, y: playerRef.current.y };
        }

        // Shout Logic
        if (greeni.state === 'chase') {
          greeni.shoutTimer -= dt;
          if (greeni.shoutTimer <= 0) {
            greeni.shoutTimer = 3000 + Math.random() * 2000; // Repeat every 3-5 seconds
          }
        }

        // Movement logic
        const gDx = greeni.target.x - greeni.x;
        const gDy = greeni.target.y - greeni.y;
        const gDist = Math.sqrt(gDx*gDx + gDy*gDy);

        const difficultyMultiplier = 1 + (day - 1) * 0.15 + (numKeysCollected >= 1 ? 0.25 : 0);
        const scaledGreeniSpeed = GREENI_BASE_SPEED * difficultyMultiplier;

        if (gDist > 5) {
          const moveSpeed = greeni.state === 'chase' ? scaledGreeniSpeed * 1.6 : scaledGreeniSpeed;
          const moveX = (gDx / gDist) * moveSpeed;
          const moveY = (gDy / gDist) * moveSpeed;
          const nextGX = greeni.x + moveX;
          const nextGY = greeni.y + moveY;
          
          let moved = false;
          if (!checkCollision(nextGX, nextGY, 15)) {
            greeni.x = nextGX; greeni.y = nextGY; moved = true;
          } else {
            if (!checkCollision(nextGX, greeni.y, 15)) { greeni.x = nextGX; moved = true; }
            else if (!checkCollision(greeni.x, nextGY, 15)) { greeni.y = nextGY; moved = true; }
          }
          if (moved) greeni.angle = Math.atan2(moveY, moveX);
          else if (greeni.state !== 'chase') {
            greeni.patrolIndex = (greeni.patrolIndex + 1) % patrolPoints.current.length;
            greeni.target = patrolPoints.current[greeni.patrolIndex];
          }
        } else {
          if (greeni.state !== 'chase') {
            greeni.patrolIndex = (greeni.patrolIndex + 1) % patrolPoints.current.length;
            greeni.target = patrolPoints.current[greeni.patrolIndex];
            greeni.state = 'patrol';
          }
        }

        // Collision with player
        if (distToPlayer < 25 && !isHiding) {
          handleJumpscare();
        }
      });

      // Heartbeat trigger (based on closest Greeni)
      heartbeatTimer += dt;
      const hbInterval = Math.max(200, minGreediDist * 2);
      if (heartbeatTimer > hbInterval) {
        playHeartbeat(minGreediDist);
        heartbeatTimer = 0;
      }

      // 3. Keys Collection
      if (numKeysCollected < 2) {
        keysRef.current.forEach((key, index) => {
          const distToKey = Math.sqrt((playerRef.current.x - key.x)**2 + (playerRef.current.y - key.y)**2);
          if (distToKey < 30) {
            keysRef.current.splice(index, 1);
            const newCount = numKeysCollected + 1;
            setNumKeysCollected(newCount);
            
            if (newCount === 1) {
              setShowStage2(true);
              // Spawn Second Key in a different location
              keysRef.current.push({ x: 100, y: 500 });
              
              // Spawn Second Greeni
              greenisRef.current.push({
                id: 2,
                x: 50,
                y: 50,
                angle: 0,
                state: 'patrol',
                target: patrolPoints.current[patrolPoints.current.length - 1],
                patrolIndex: patrolPoints.current.length - 1,
                shoutTimer: 0
              });
              setFlash(0.5);
              setTimeout(() => setFlash(0), 100);
              setTimeout(() => setShowStage2(false), 1500);
            }
          }
        });
      }

      // 4. Exit
      if (numKeysCollected === 2) {
        const distToExit = Math.sqrt((playerRef.current.x - (exitRef.current.x + exitRef.current.w/2))**2 + (playerRef.current.y - (exitRef.current.y + exitRef.current.h/2))**2);
        if (distToExit < 40) {
          setGameState('escaped');
        }
      }

      // 5. Drawing
      ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
      
      // Floor
      ctx.fillStyle = '#1a1a1a'; // Brighter floor
      ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
      
      // Draw Grid for better visibility
      ctx.strokeStyle = '#222';
      ctx.lineWidth = 0.5;
      for(let i=0; i<CANVAS_WIDTH; i+=50) {
        ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, CANVAS_HEIGHT); ctx.stroke();
      }
      for(let i=0; i<CANVAS_HEIGHT; i+=50) {
        ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(CANVAS_WIDTH, i); ctx.stroke();
      }

      // Draw Hiding Spots
      ctx.fillStyle = '#333';
      HIDING_SPOTS.forEach(spot => {
        ctx.fillRect(spot.x, spot.y, spot.w, spot.h);
        ctx.strokeStyle = 'rgba(255,255,255,0.1)';
        ctx.strokeRect(spot.x, spot.y, spot.w, spot.h);
      });

      // Draw Walls
      ctx.fillStyle = '#222';
      WALLS.forEach(wall => {
        ctx.fillRect(wall.x, wall.y, wall.w, wall.h);
        ctx.strokeStyle = '#444';
        ctx.strokeRect(wall.x, wall.y, wall.w, wall.h);
      });

      // Draw Doors
      doorsRef.current.forEach(door => {
        ctx.fillStyle = door.isOpen ? 'rgba(74, 44, 29, 0.4)' : '#4a2c1d'; // Semi-transparent when open
        ctx.fillRect(door.x, door.y, door.w, door.h);
        ctx.strokeStyle = door.isOpen ? 'rgba(99, 60, 39, 0.3)' : '#633c27';
        ctx.strokeRect(door.x, door.y, door.w, door.h);
        
        // Door handle
        if (!door.isOpen) {
          ctx.fillStyle = 'gold';
          ctx.beginPath();
          ctx.arc(door.x + door.w/2, door.y + door.h/2, 3, 0, Math.PI*2);
          ctx.fill();
        }
      });

      // Draw Exit
      const isExitOpen = numKeysCollected === 2;
      ctx.fillStyle = isExitOpen ? '#10b981' : '#450a0a';
      ctx.fillRect(exitRef.current.x, exitRef.current.y, exitRef.current.w, exitRef.current.h);
      ctx.strokeStyle = isExitOpen ? '#34d399' : '#7f1d1d';
      ctx.strokeRect(exitRef.current.x, exitRef.current.y, exitRef.current.w, exitRef.current.h);
      
      // Draw Keys
      keysRef.current.forEach(key => {
        ctx.save();
        ctx.shadowBlur = 15;
        ctx.shadowColor = 'gold';
        ctx.fillStyle = '#fbbf24';
        ctx.beginPath();
        ctx.arc(key.x, key.y, 10, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      });

      // Draw Entities (only if in light or debug)
      ctx.shadowBlur = 0;

      // Flashlight / Vision Mask (Subtle vignette instead of total darkness)
      const maskGradient = ctx.createRadialGradient(
        playerRef.current.x, playerRef.current.y, 0,
        playerRef.current.x, playerRef.current.y, VISION_REVEAL_RADIUS
      );
      maskGradient.addColorStop(0, 'rgba(0,0,0,0)');
      maskGradient.addColorStop(1, 'rgba(0,0,0,0.2)');

      // Draw Player
      if (!isHiding) {
        ctx.save();
        ctx.shadowBlur = 10;
        ctx.shadowColor = '#3b82f6';
        ctx.translate(playerRef.current.x, playerRef.current.y);
        ctx.rotate(playerRef.current.angle);
        ctx.fillStyle = '#3b82f6';
        ctx.beginPath();
        ctx.arc(0, 0, 12, 0, Math.PI * 2);
        ctx.fill();
        // Nose/Direction
        ctx.fillStyle = 'white';
        ctx.fillRect(8, -2, 6, 4);
        ctx.restore();
      }

      // Draw Greenis
      greenisRef.current.forEach(greeni => {
        ctx.save();
        ctx.shadowBlur = 15;
        ctx.shadowColor = greeni.id === 2 ? '#2563eb' : '#16a34a'; // Blue for second greeni
        ctx.translate(greeni.x, greeni.y);
        ctx.rotate(greeni.angle);
        ctx.fillStyle = greeni.id === 2 ? '#3b82f6' : '#16a34a'; // Blue for second greeni
        ctx.beginPath();
        ctx.arc(0, 0, 15, 0, Math.PI * 2);
        ctx.fill();
        // Scarier Eyes
        ctx.fillStyle = 'red';
        ctx.beginPath(); ctx.arc(8, -5, 4, 0, Math.PI*2); ctx.fill();
        ctx.beginPath(); ctx.arc(8, 5, 4, 0, Math.PI*2); ctx.fill();
        ctx.restore();

        // Shout Bubble
        if (greeni.state === 'chase' && greeni.shoutTimer > 0) {
          ctx.save();
          ctx.translate(greeni.x, greeni.y - 40);
          
          // Bubble background for better visibility
          ctx.fillStyle = 'black';
          ctx.strokeStyle = '#ef4444';
          ctx.lineWidth = 1;
          const txt = "I SEE YOU!";
          ctx.font = 'bold 16px font-mono';
          const tw = ctx.measureText(txt).width;
          
          ctx.fillRect(-tw/2 - 10, -20, tw + 20, 30);
          ctx.strokeRect(-tw/2 - 10, -20, tw + 20, 30);
          
          ctx.fillStyle = '#ef4444';
          ctx.textAlign = 'center';
          ctx.fillText(txt, 0, 0);
          ctx.restore();
        }
      });

      // Apply Dark Mask
      ctx.fillStyle = maskGradient;
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

      requestAnimationFrame(update);
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      keysDown.current.add(e.key);
      if (gameState === 'intro' && (e.key === 'Enter' || e.key === ' ')) {
        initAudio();
        startGame();
      }
      if (gameState === 'gameover' && (e.key === 'Enter' || e.key === ' ')) {
        startGame();
      }
      if (gameState === 'escaped' && (e.key === 'Enter' || e.key === ' ')) {
        window.location.reload();
      }
    };
    const handleKeyUp = (e: KeyboardEvent) => keysDown.current.delete(e.key);

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    requestAnimationFrame(update);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [gameState, isHiding, isAudioOn, numKeysCollected]);

  return (
    <div className="min-h-screen bg-black text-white font-mono flex flex-col items-center justify-center p-4 relative overflow-hidden">
      {/* Background Visuals */}
      <div className="absolute inset-0 blood-vignette opacity-60 z-10" />
      
      {/* HUD Background Glitch */}
      <AnimatePresence>
        {gameState === 'intro' && (
          <motion.div 
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            className="z-20 text-center flex flex-col items-center"
          >
            <h1 className="text-9xl font-horror text-red-700 mb-4 tracking-tighter title-glow">GREENI</h1>
            <p className="text-red-500/50 text-xs tracking-[8px] uppercase mb-12">Professional Horror Escape</p>
            
            <div className="grid grid-cols-2 gap-4 max-w-lg mb-12">
              <div className="bg-red-950/20 border border-red-900/30 p-4 rounded text-left">
                <div className="flex items-center gap-2 mb-2 text-red-500 font-bold">
                  <Move className="w-4 h-4" /> HARAKAT
                </div>
                <p className="text-[10px] text-gray-500 leading-relaxed uppercase">WASD - Yurish<br/>Shift - Yugurish (Shovqin)<br/>Space - Yashirinish</p>
              </div>
              <div className="bg-red-950/20 border border-red-900/30 p-4 rounded text-left">
                <div className="flex items-center gap-2 mb-2 text-red-500 font-bold">
                  <Search className="w-4 h-4" /> VAZIFA
                </div>
                <p className="text-[10px] text-gray-500 leading-relaxed uppercase">2ta sariq kalitni toping<br/>Yashil eshikdan chiqing<br/>5 kun ichida qutiling</p>
              </div>
            </div>

            <button 
              onClick={() => { initAudio(); startGame(); }}
              className="px-16 py-6 bg-red-700 hover:bg-red-600 transition-all font-black text-2xl tracking-[4px] uppercase active:scale-95 shadow-[0_0_40px_rgba(185,28,28,0.4)]"
            >
              Uyingizga kiring
            </button>
          </motion.div>
        )}

        {gameState === 'playing' && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="z-20 flex gap-8 items-start">
            {/* Game Area */}
            <div className="flex flex-col items-center relative">
              {/* HUD Overlay */}
              <div className="absolute top-4 left-4 flex flex-col gap-2 z-30">
                <div className="flex items-center gap-2 text-red-600 font-horror text-3xl">
                  <Skull /> {day}-KUN {numKeysCollected >= 1 && <span className="text-yellow-500 ml-2 animate-pulse">[2-BOSQICH]</span>}
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-24 h-1.5 bg-gray-900 border border-gray-800">
                    <motion.div 
                      className="h-full bg-red-600" 
                      animate={{ width: `${stamina}%` }} 
                    />
                  </div>
                </div>
              </div>

              <div className="absolute top-4 right-4 flex gap-2 z-30">
                 <div className={`p-2 border flex items-center gap-1 ${numKeysCollected === 2 ? 'border-green-600 text-green-500 shadow-[0_0_10px_rgba(22,163,74,0.5)]' : 'border-gray-900 text-gray-800'}`}>
                  <Key className="w-5 h-5" />
                  <span className="text-xs font-bold">{numKeysCollected}/2</span>
                </div>
                <button onClick={() => setIsAudioOn(!isAudioOn)} className="p-2 bg-gray-900 text-gray-500 hover:text-white transition-colors">
                  {isAudioOn ? <Volume2 className="w-5 h-5" /> : <VolumeX className="w-5 h-5" />}
                </button>
              </div>

              {isHiding && (
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-center pointer-events-none z-30">
                  <Eye className="w-12 h-12 text-white/50 animate-pulse mx-auto mb-2" />
                  <p className="text-[10px] tracking-[3px] uppercase text-white/30 font-bold">SIZ YASHIRINDINGIZ</p>
                </div>
              )}

              {interactPrompt && !isHiding && (
                <div className="absolute bottom-12 left-1/2 -translate-x-1/2 bg-black/80 border border-white/20 px-6 py-2 rounded-full z-40 animate-bounce">
                  <p className="text-[10px] text-white font-bold tracking-[2px] uppercase">{interactPrompt}</p>
                </div>
              )}

              <canvas 
                ref={canvasRef} 
                width={CANVAS_WIDTH} 
                height={CANVAS_HEIGHT}
                className="border-2 border-red-900/20 shadow-[0_0_80px_rgba(0,0,0,1)] bg-black"
              />

              {showStage2 && (
                <motion.div 
                  initial={{ opacity: 0, scale: 0.5 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0 }}
                  className="absolute inset-0 z-[60] flex items-center justify-center pointer-events-none"
                >
                  <div className="flex flex-col items-center">
                    <div className="bg-red-700 font-horror text-white text-6xl px-12 py-6 border-8 border-white skew-x-[-10deg] shadow-[0_0_100px_rgba(255,0,0,0.5)]">
                      2-BOSQICH
                    </div>
                    <div className="mt-4 bg-black/80 px-4 py-2 text-yellow-500 font-bold tracking-[3px] uppercase">
                      Ikkinchi kalit paydo bo'ldi!
                    </div>
                  </div>
                </motion.div>
              )}
            </div>

            {/* Rules Sidebar (Right Side) */}
            <div className="w-72 flex flex-col gap-6 p-6 bg-red-950/5 border border-red-900/20 rounded shadow-[inset_0_0_40px_rgba(153,27,27,0.05)]">
              <div className="border-b border-red-900/30 pb-4">
                <h2 className="font-horror text-red-600 text-3xl mb-1">
                   {numKeysCollected >= 1 ? (numKeysCollected === 2 ? 'CHIQISH OCHIQ' : '2-BOSQICH: QIDIRUV') : '1-BOSQICH: QIDIRUV'}
                </h2>
                <p className="text-[8px] text-red-500/40 uppercase tracking-[2px]">O'yin holati</p>
              </div>

              <div className="space-y-6">
                <div>
                    <h3 className="text-red-500 text-xs font-bold uppercase tracking-widest mb-3 flex items-center gap-2">
                        <Move className="w-3 h-3" /> BOSHQARUV
                    </h3>
                    <ul className="space-y-2 text-[11px] text-gray-400 leading-relaxed">
                        <li className="flex justify-between border-b border-white/5 pb-1">
                            <span>YURISH</span>
                            <span className="text-white font-bold">W, A, S, D</span>
                        </li>
                        <li className="flex justify-between border-b border-white/5 pb-1">
                            <span>YUGURISH</span>
                            <span className="text-white font-bold underline">SHIFT</span>
                        </li>
                        <li className="flex justify-between border-b border-white/5 pb-1">
                            <span>YASHIRINISH</span>
                            <span className="text-white font-bold">PROBEL (SPACE)</span>
                        </li>
                        <li className="flex justify-between border-b border-white/5 pb-1">
                            <span>ESHIK OCHISH/YOPISH</span>
                            <span className="text-red-500 font-bold">K</span>
                        </li>
                    </ul>
                </div>

                <div>
                    <h3 className="text-red-500 text-xs font-bold uppercase tracking-widest mb-3 flex items-center gap-2">
                        <Search className="w-3 h-3" /> VAZIFA
                    </h3>
                    <p className="text-[11px] text-gray-400 mb-2 leading-relaxed italic">
                        "Uy ichidan <span className="text-yellow-500 font-bold">oltin kalitni</span> toping va yashil darvozaga yetib boring."
                    </p>
                    <div className="p-3 bg-red-900/10 border border-red-900/30 rounded">
                        <p className="text-[9px] text-red-400 uppercase font-black">Eslatma:</p>
                        <p className="text-[10px] text-gray-500">Yugurish shovqin chiqaradi va Greeni buni eshitadi!</p>
                    </div>
                </div>

                <div className="pt-4 border-t border-red-900/30">
                    <div className="flex items-center gap-3 text-red-700/50">
                        <Activity className="w-4 h-4 animate-pulse" />
                        <span className="text-[9px] uppercase tracking-[3px]">Tizim Faol</span>
                    </div>
                </div>
              </div>
            </div>
          </motion.div>
        )}

        {gameState === 'day_transition' && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="z-[200] fixed inset-0 bg-black flex flex-col items-center justify-center p-8 text-center"
          >
            <motion.div
              initial={{ scale: 0.8, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              transition={{ duration: 0.5, ease: "easeOut" }}
            >
              <h1 className="text-[15vw] font-horror text-white mb-2 leading-none drop-shadow-[0_0_80px_rgba(255,255,255,0.2)]">
                {day}-KUN
              </h1>
              <div className="w-full h-1 bg-red-900/30 mb-8 overflow-hidden">
                <motion.div 
                    initial={{ x: "-100%" }}
                    animate={{ x: "0%" }}
                    transition={{ duration: 1.0, ease: "linear" }}
                    className="w-full h-full bg-red-700"
                />
              </div>
              <p className="text-red-600 font-bold text-xl tracking-[15px] uppercase animate-pulse">
                OYOQ TOVUSHLARI YAQINLASHMOQDA...
              </p>
            </motion.div>
          </motion.div>
        )}

        {gameState === 'jumpscare' && (
          <motion.div 
            initial={{ scale: 0.1, opacity: 0 }}
            animate={{ scale: [1, 1.2, 1], opacity: 1 }}
            className="fixed inset-0 z-[100] bg-black jumpscare-shake flex items-center justify-center"
          >
            <div className="relative w-full h-full">
              <img 
                src="https://picsum.photos/seed/greeni-horror/1200/1200" 
                className="w-full h-full object-cover grayscale brightness-20 contrast-[200%]"
                referrerPolicy="no-referrer"
              />
              <div className="absolute inset-0 bg-red-900/20 mix-blend-multiply flicker" />
              <h1 className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-[15vw] font-horror text-red-700 drop-shadow-[0_0_50px_rgba(0,0,0,1)]">VATU!</h1>
            </div>
          </motion.div>
        )}

        {gameState === 'gameover' && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="z-50 text-center">
            <h1 className="text-[12vw] font-bloody text-red-700 mb-8 uppercase leading-none">O'YIN TUGADI</h1>
            <p className="text-gray-500 tracking-[5px] mb-12 uppercase">Greeni sizni butunlay asrab qoldi.</p>
              <button 
                onClick={startGame}
                className="px-12 py-4 border border-white/20 hover:bg-white hover:text-black transition-all font-bold"
              >
                BOSHQATTAN BOSHLASH
              </button>
          </motion.div>
        )}

        {gameState === 'escaped' && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="z-50 text-center">
             <h1 className="text-[12vw] font-horror text-green-500 mb-8 uppercase leading-none">SIZ QUTULDINGIZ!</h1>
            <p className="text-gray-400 tracking-[5px] mb-12 uppercase">Barcha to'siqlardan o'tdingiz. Ozodlik...</p>
            <button 
              onClick={() => window.location.reload()}
              className="px-12 py-4 bg-green-600 text-white font-bold hover:bg-green-500 transition-all shadow-[0_0_30px_rgba(34,197,94,0.3)]"
            >
              TEACHER: "VAY BUNCHALAR ZO'R!"
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      <div 
        className="fixed inset-0 z-[200] pointer-events-none transition-opacity duration-100"
        style={{ backgroundColor: 'white', opacity: flash }}
      />
    </div>
  );
}
