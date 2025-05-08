require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : ['https://knowyourpartner.netlify.app', 'http://localhost:3000'];

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST'],
  },
});

// Middleware
app.use(cors({
  origin: allowedOrigins,
  methods: ['GET', 'POST'],
}));
app.use(express.static('public'));

// Load questions from questions.json with error handling
let questions;
try {
  questions = require('./questions.json');
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new Error('questions.json must contain a non-empty array of questions');
  }
} catch (error) {
  console.error('Error loading questions.json:', error);
  process.exit(1);
}

// Store room states
const rooms = {};

// Fisher-Yates shuffle for randomizing questions
function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

// Handle socket connections
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('joinRoom', ({ roomCode, playerName }, callback) => {
    try {
      if (!/^\d{6}$/.test(roomCode)) {
        callback({ success: false, message: 'Room code must be a 6-digit number' });
        return;
      }

      if (!rooms[roomCode]) {
        const numQuestions = Math.min(10, questions.length);
        rooms[roomCode] = {
          players: [],
          playerNames: {},
          currentQuestion: 0,
          scores: {},
          questions: shuffle([...questions]).slice(0, numQuestions),
          answers: {},
          guesses: {},
          phase: 'answer',
          waitingFor: [],
          lastActivity: Date.now(),
        };
      }

      if (rooms[roomCode].players.length >= 2) {
        callback({ success: false, message: 'Room is full' });
        return;
      }

      rooms[roomCode].players.push(socket.id);
      const sanitizePlayerName = (name) => {
        const maxLength = 20;
        return (name || `Player ${rooms[roomCode].players.length}`)
          .substring(0, maxLength)
          .replace(/[<>&"']/g, '');
      };
      rooms[roomCode].playerNames[socket.id] = sanitizePlayerName(playerName);
      rooms[roomCode].scores[socket.id] = 0;
      rooms[roomCode].lastActivity = Date.now();
      socket.join(roomCode);
      callback({ success: true });

      io.to(roomCode).emit('playerJoined', {
        playerId: socket.id,
        playerName: rooms[roomCode].playerNames[socket.id],
        players: rooms[roomCode].players.map((id) => ({
          id,
          name: rooms[roomCode].playerNames[id],
        })),
      });

      if (rooms[roomCode].players.length === 2) {
        io.to(roomCode).emit('startGame', {
          question: rooms[roomCode].questions[0],
          questionIndex: 0,
          phase: 'answer',
        });
      }
    } catch (error) {
      console.error('Error in joinRoom:', error);
      callback({ success: false, message: 'Internal server error' });
    }
  });

  socket.on('submitAnswer', ({ roomCode, questionIndex, answer }) => {
    try {
      const room = rooms[roomCode];
      if (!room || room.currentQuestion !== questionIndex || room.phase !== 'answer') return;
      if (room.waitingFor.includes(socket.id)) return;
      if (typeof answer !== 'string' || !answer.trim()) return;
      // Optional: Validate answer against question options
      // const validOptions = room.questions[questionIndex].options;
      // if (!validOptions.includes(answer)) return;

      if (!room.answers[questionIndex]) room.answers[questionIndex] = {};
      room.answers[questionIndex][socket.id] = answer;
      room.waitingFor.push(socket.id);
      room.lastActivity = Date.now();

      if (room.waitingFor.length === 2) {
        room.waitingFor = [];
        room.phase = 'guess';
        io.to(roomCode).emit('startGuessPhase', {
          question: room.questions[questionIndex],
          questionIndex,
        });
      } else {
        io.to(roomCode).emit('waitingForPartner', {
          message: `${room.playerNames[socket.id]} has submitted their answer. Waiting for the other player...`,
        });
      }
    } catch (error) {
      console.error('Error in submitAnswer:', error);
    }
  });

  socket.on('submitGuess', ({ roomCode, questionIndex, guess, targetPlayerId }) => {
    try {
      const room = rooms[roomCode];
      if (!room || room.currentQuestion !== questionIndex || room.phase !== 'guess') return;
      if (room.waitingFor.includes(socket.id)) return;
      if (typeof guess !== 'string' || !guess.trim()) return;

      if (!room.guesses[questionIndex]) room.guesses[questionIndex] = {};
      room.guesses[questionIndex][socket.id] = { guess, targetPlayerId };
      room.waitingFor.push(socket.id);
      room.lastActivity = Date.now();

      if (room.waitingFor.length === 2) {
        room.waitingFor = [];
        const player1Id = room.players[0];
        const player2Id = room.players[1];

        const player1Guess = room.guesses[questionIndex][player1Id].guess;
        const player2Answer = room.answers[questionIndex][player2Id];
        if (player1Guess === player2Answer) {
          room.scores[player1Id] += 10;
        }

        const player2Guess = room.guesses[questionIndex][player2Id].guess;
        const player1Answer = room.answers[questionIndex][player1Id];
        if (player2Guess === player1Answer) {
          room.scores[player2Id] += 10;
        }

        io.to(roomCode).emit('updateScores', room.scores);

        io.to(roomCode).emit('revealAnswers', {
          questionIndex,
          answers: room.answers[questionIndex],
          guesses: room.guesses[questionIndex],
          playerNames: room.playerNames,
        });

        room.currentQuestion++;
        if (room.currentQuestion < room.questions.length) {
          room.phase = 'answer';
          io.to(roomCode).emit('startAnswerPhase', {
            question: room.questions[room.currentQuestion],
            questionIndex: room.currentQuestion,
          });
        } else {
          io.to(roomCode).emit('gameOver', {
            scores: room.scores,
            playerNames: room.playerNames,
          });
        }
      } else {
        io.to(roomCode).emit('waitingForPartner', {
          message: `${room.playerNames[socket.id]} has submitted their guess. Waiting for the other player...`,
        });
      }
    } catch (error) {
      console.error('Error in submitGuess:', error);
    }
  });

  socket.on('sendMessage', ({ roomCode, message }) => {
    try {
      const room = rooms[roomCode];
      if (!room) return;
      io.to(roomCode).emit('receiveMessage', {
        playerId: socket.id,
        playerName: room.playerNames[socket.id],
        message,
      });
    } catch (error) {
      console.error('Error in sendMessage:', error);
    }
  });

  socket.on('disconnect', () => {
    try {
      for (const roomCode in rooms) {
        const room = rooms[roomCode];
        const playerIndex = room.players.indexOf(socket.id);
        if (playerIndex !== -1) {
          const playerName = room.playerNames[socket.id];
          room.players.splice(playerIndex, 1);
          delete room.scores[socket.id];
          delete room.playerNames[socket.id];
          io.to(roomCode).emit('playerLeft', {
            playerId: socket.id,
            playerName,
          });
          if (room.players.length === 0) {
            delete rooms[roomCode];
          }
          break;
        }
      }
      console.log('User disconnected:', socket.id);
    } catch (error) {
      console.error('Error in disconnect:', error);
    }
  });
});

// Clean up stale rooms
const cleanupInterval = setInterval(() => {
  for (const roomCode in rooms) {
    const room = rooms[roomCode];
    if (room.players.length === 0 || (Date.now() - room.lastActivity) > 30 * 60 * 1000) {
      delete rooms[roomCode];
      console.log(`Cleaned up stale room: ${roomCode}`);
    }
  }
}, 5 * 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});