// Сервер многопользовательской игры «Пинай мяч».
// Держит авторитетную физику: клиенты шлют только ввод, сервер считает мир.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// ---------- Раздача статики из public/ ----------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";
  const filePath = path.join(__dirname, "public", path.normalize(urlPath));
  // Защита от выхода за пределы public/
  if (!filePath.startsWith(path.join(__dirname, "public"))) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end("Not found");
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  });
});

// ---------- Игровой мир ----------
const W = 1000;       // ширина поля
const H = 620;        // высота поля
const WALL = 14;      // толщина бортов
const GOAL_H = 220;   // высота ворот (проём)
const PR = 18;        // радиус игрока
const BR = 13;        // радиус мяча

const PLAYER_ACCEL = 0.7;
const PLAYER_MAX = 5.2;
const PLAYER_FRICTION = 0.86;
const BALL_FRICTION = 0.985;   // трение мяча по земле (горизонтальное)
const BALL_AIR_DRAG = 0.997;   // сопротивление воздуха в полёте
const KICK_POWER = 9;
const KICK_REACH = 8;
const KICK_LIFT = 8;           // подброс мяча при ударе
const GRAVITY = 0.45;          // притяжение к земле за тик
const BOUNCE = 0.6;            // упругость отскока от газона
const REACH_HEIGHT = PR * 1.5; // выше этого мяч перелетает игроков
const BAR_HEIGHT = 60;         // высота перекладины — выше гол не считается
const COLORS_RED = ["#ff5a5a", "#ff8a4c", "#ffd166", "#e84393"];
const COLORS_BLUE = ["#4ca3ff", "#5ad1c8", "#a06bff", "#74b9ff"];

const goalTop = (H - GOAL_H) / 2;
const goalBottom = goalTop + GOAL_H;

const ball = { x: W / 2, y: H / 2, z: 0, vx: 0, vy: 0, vz: 0 };
const players = new Map(); // id -> {id, name, color, team, x, y, vx, vy, input}
const score = { red: 0, blue: 0 };
let nextId = 1;

function spawnFor(team) {
  return team === "red"
    ? { x: W * 0.25, y: H / 2 }
    : { x: W * 0.75, y: H / 2 };
}

function resetPositions() {
  ball.x = W / 2; ball.y = H / 2; ball.z = 0;
  ball.vx = 0; ball.vy = 0; ball.vz = 0;
  for (const p of players.values()) {
    const s = spawnFor(p.team);
    p.x = s.x; p.y = s.y; p.vx = 0; p.vy = 0;
  }
}

function addPlayer(name) {
  // Балансируем команды по числу игроков
  let red = 0, blue = 0;
  for (const p of players.values()) p.team === "red" ? red++ : blue++;
  const team = red <= blue ? "red" : "blue";
  const pool = team === "red" ? COLORS_RED : COLORS_BLUE;
  const id = nextId++;
  const s = spawnFor(team);
  const p = {
    id,
    name: (name || "Игрок").slice(0, 16),
    color: pool[id % pool.length],
    team,
    x: s.x, y: s.y, vx: 0, vy: 0, heading: team === "red" ? 0 : Math.PI,
    prevKick: false, kickLock: 0,
    input: { mx: 0, my: 0, kick: false },
  };
  players.set(id, p);
  return p;
}

function circleHitsWall(x, y, r) {
  // Сплошные борта по всему периметру — используется для игроков,
  // чтобы они не выбегали за поле через проём ворот (мяч обрабатывается отдельно).
  let nx = x, ny = y, hit = { x: false, y: false };
  if (nx - r < WALL) { nx = WALL + r; hit.x = true; }
  if (nx + r > W - WALL) { nx = W - WALL - r; hit.x = true; }
  if (ny - r < WALL) { ny = WALL + r; hit.y = true; }
  if (ny + r > H - WALL) { ny = H - WALL - r; hit.y = true; }
  return { nx, ny, hit };
}

function step() {
  // --- Игроки ---
  for (const p of players.values()) {
    // Замах: по фронту нажатия удара ненадолго «вкапываемся» (стоп для пинка)
    if (p.input.kick && !p.prevKick) p.kickLock = 26; // ~0.43 с
    p.prevKick = p.input.kick;

    if (p.kickLock > 0) {
      p.kickLock--;
      p.vx *= 0.5; p.vy *= 0.5; // не разгоняемся, быстро тормозим
    } else {
      // Вектор движения от клиента (камеро-зависимый), уже в координатах поля
      p.vx += p.input.mx * PLAYER_ACCEL;
      p.vy += p.input.my * PLAYER_ACCEL;
      p.vx *= PLAYER_FRICTION;
      p.vy *= PLAYER_FRICTION;
    }
    const sp = Math.hypot(p.vx, p.vy);
    if (sp > PLAYER_MAX) { p.vx = p.vx / sp * PLAYER_MAX; p.vy = p.vy / sp * PLAYER_MAX; }
    // Поворот персонажа в сторону движения (когда реально движется)
    if (sp > 0.4) p.heading = Math.atan2(p.vx, p.vy);
    p.x += p.vx; p.y += p.vy;
    const c = circleHitsWall(p.x, p.y, PR);
    p.x = c.nx; p.y = c.ny;
    if (c.hit.x) p.vx *= -0.3;
    if (c.hit.y) p.vy *= -0.3;
  }

  // --- Столкновения игрок-игрок (расталкивание) ---
  const arr = [...players.values()];
  for (let a = 0; a < arr.length; a++) {
    for (let b = a + 1; b < arr.length; b++) {
      const p1 = arr[a], p2 = arr[b];
      const dx = p2.x - p1.x, dy = p2.y - p1.y;
      const d = Math.hypot(dx, dy) || 0.01;
      const overlap = PR * 2 - d;
      if (overlap > 0) {
        const nx = dx / d, ny = dy / d;
        p1.x -= nx * overlap / 2; p1.y -= ny * overlap / 2;
        p2.x += nx * overlap / 2; p2.y += ny * overlap / 2;
      }
    }
  }

  // --- Мяч ---
  // Высота: гравитация и отскок от газона
  ball.vz -= GRAVITY;
  ball.z += ball.vz;
  if (ball.z <= 0) {
    ball.z = 0;
    if (ball.vz < 0) ball.vz = -ball.vz * BOUNCE;
    if (Math.abs(ball.vz) < 0.6) ball.vz = 0; // успокаиваем мелкие подскоки
  }
  const airborne = ball.z > 1;
  // По земле — трение, в воздухе — лёгкое сопротивление
  const drag = airborne ? BALL_AIR_DRAG : BALL_FRICTION;
  ball.vx *= drag;
  ball.vy *= drag;
  ball.x += ball.vx;
  ball.y += ball.vy;

  // Столкновение мяча с игроками — только если мяч не выше игрока
  for (const p of players.values()) {
    if (ball.z > REACH_HEIGHT) continue; // высокий мяч перелетает
    const dx = ball.x - p.x, dy = ball.y - p.y;
    const d = Math.hypot(dx, dy) || 0.01;
    const nx = dx / d, ny = dy / d;
    if (d < PR + BR) {
      const overlap = PR + BR - d;
      ball.x += nx * overlap; ball.y += ny * overlap;
      const playerSpeed = Math.hypot(p.vx, p.vy);
      ball.vx += nx * (playerSpeed * 0.6 + 2.2);
      ball.vy += ny * (playerSpeed * 0.6 + 2.2);
    }
    // Удар по кнопке — толчок вперёд и подброс вверх
    if (p.input.kick && d < PR + BR + KICK_REACH) {
      ball.vx += nx * KICK_POWER;
      ball.vy += ny * KICK_POWER;
      ball.vz += KICK_LIFT;
    }
  }

  // Гол засчитывается, только если мяч ниже перекладины и в створе
  const inBand = ball.y > goalTop && ball.y < goalBottom;
  const lowEnough = ball.z < BAR_HEIGHT;
  if (inBand && lowEnough && ball.x - BR < 0) { score.blue++; resetPositions(); return; }
  if (inBand && lowEnough && ball.x + BR > W) { score.red++; resetPositions(); return; }

  // Стены. Боковой проём открыт только для низкого мяча в створе;
  // высокий мяч отскакивает от верха ворот обратно в поле.
  const openSide = inBand && lowEnough;
  if (!openSide) {
    if (ball.x - BR < WALL) { ball.x = WALL + BR; ball.vx *= -0.75; }
    if (ball.x + BR > W - WALL) { ball.x = W - WALL - BR; ball.vx *= -0.75; }
  }
  if (ball.y - BR < WALL) { ball.y = WALL + BR; ball.vy *= -0.75; }
  if (ball.y + BR > H - WALL) { ball.y = H - WALL - BR; ball.vy *= -0.75; }
}

function broadcast() {
  const state = JSON.stringify({
    type: "state",
    ball: { x: Math.round(ball.x), y: Math.round(ball.y), z: Math.round(ball.z) },
    score,
    players: [...players.values()].map((p) => ({
      id: p.id, n: p.name, c: p.color, t: p.team,
      x: Math.round(p.x), y: Math.round(p.y),
      h: Math.round(p.heading * 100) / 100,
      k: p.input.kick ? 1 : 0,
    })),
  });
  for (const ws of wss.clients) {
    if (ws.readyState === ws.OPEN) ws.send(state);
  }
}

// 60 тиков физики в секунду, рассылка каждый тик
setInterval(() => { step(); broadcast(); }, 1000 / 60);

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  let player = null;
  ws.send(JSON.stringify({ type: "config", W, H, WALL, GOAL_H, PR, BR }));

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === "join") {
      player = addPlayer(msg.name);
      ws.send(JSON.stringify({ type: "you", id: player.id, team: player.team }));
    } else if (msg.type === "input" && player) {
      const i = player.input;
      // Камеро-зависимый вектор движения в координатах поля, длина <= 1
      let mx = +msg.mx || 0, my = +msg.my || 0;
      const len = Math.hypot(mx, my);
      if (len > 1) { mx /= len; my /= len; }
      i.mx = mx; i.my = my; i.kick = !!msg.kick;
    }
  });

  ws.on("close", () => {
    if (player) players.delete(player.id);
  });
});

server.listen(PORT, () => {
  console.log(`⚽ Сервер запущен: http://localhost:${PORT}`);
});
