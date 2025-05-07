const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: ['https://your-netlify-app.netlify.app', 'http://localhost:3000'], // Replace with your Netlify URL after deploying
    methods: ['GET', 'POST'],
  },
});

// Middleware
app.use(cors());
app.use(express.static('public'));

// Load questions (can fetch from Netlify if hosted there)
const questions = require('./questions.json');

// Store room states
const rooms = {};

// Handle socket connections
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Join a room
  socket.on('joinRoom', ({ roomCode, playerName }, callback) => {
    if (roomCode.length !== 6) {
      callback({ success: false, message: 'Room code must be 6 digits' });
      return;
    }

    if (!rooms[roomCode]) {
      rooms[roomCode] = {
        players: [],
        playerNames: {},
        currentQuestion: 0,
        scores: {},
        questions: questions.sort(() => 0.5 - Math.random()).slice(0, 10), // Random subset of 10 questions
        answers: {}, // Format: { questionIndex: { playerId1: answer1, playerId2: answer2 } }
        guesses: {}, // Format: { questionIndex: { playerId1: guess1, playerId2: guess2 } }
        phase: 'answer', // 'answer' or 'guess'
        waitingFor: [], // Tracks which players have submitted answers or guesses
      };
    }

    if (rooms[roomCode].players.length >= 2) {
      callback({ success: false, message: 'Room is full' });
      return;
    }

    rooms[roomCode].players.push(socket.id);
    rooms[roomCode].playerNames[socket.id] = playerName || `Player ${rooms[roomCode].players.length}`;
    rooms[roomCode].scores[socket.id] = 0;
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
  });

  // Handle answer submission (each player submits their own preference)
  socket.on('submitAnswer', ({ roomCode, questionIndex, answer }) => {
    const room = rooms[roomCode];
    if (!room || room.currentQuestion !== questionIndex || room.phase !== 'answer') return;

    if (!room.answers[questionIndex]) room.answers[questionIndex] = {};
    room.answers[questionIndex][socket.id] = answer;
    room.waitingFor.push(socket.id);

    if (room.waitingFor.length === 2) {
      // Both players have submitted answers, move to guess phase
      room.waitingFor = [];
      room.phase = 'guess';
      io.to(roomCode).emit('startGuessPhase', {
        question: room.questions[questionIndex],
        questionIndex,
      });
    } else {
      // Notify the other player to wait
      io.to(roomCode).emit('waitingForPartner', {
        message: `${room.playerNames[socket.id]} has submitted their answer. Waiting for the other player...`,
      });
    }
  });

  // Handle guess submission (each player guesses the other's answer)
  socket.on('submitGuess', ({ roomCode, questionIndex, guess, targetPlayerId }) => {
    const room = rooms[roomCode];
    if (!room || room.currentQuestion !== questionIndex || room.phase !== 'guess') return;

    if (!room.guesses[questionIndex]) room.guesses[questionIndex] = {};
    room.guesses[questionIndex][socket.id] = { guess, targetPlayerId };
    room.waitingFor.push(socket.id);

    if (room.waitingFor.length === 2) {
      // Both players have submitted guesses, calculate scores
      room.waitingFor = [];
      const player1Id = room.players[0];
      const player2Id = room.players[1];

      // Player 1 guesses Player 2's answer
      const player1Guess = room.guesses[questionIndex][player1Id].guess;
      const player2Answer = room.answers[questionIndex][player2Id];
      if (player1Guess === player2Answer) {
        room.scores[player1Id] += 10;
      }

      // Player 2 guesses Player 1's answer
      const player2Guess = room.guesses[questionIndex][player2Id].guess;
      const player1Answer = room.answers[questionIndex][player1Id];
      if (player2Guess === player1Answer) {
        room.scores[player2Id] += 10;
      }

      // Broadcast updated scores
      io.to(roomCode).emit('updateScores', room.scores);

      // Reveal answers
      io.to(roomCode).emit('revealAnswers', {
        questionIndex,
        answers: room.answers[questionIndex],
        guesses: room.guesses[questionIndex],
        playerNames: room.playerNames,
      });

      // Move to next question
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
  });

  // Handle chat messages
  socket.on('sendMessage', ({ roomCode, message }) => {
    io.to(roomCode).emit('receiveMessage', {
      playerId: socket.id,
      playerName: rooms[roomCode].playerNames[socket.id],
      message,
    });
  });

  // Handle disconnection
  socket.on('disconnect', () => {
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
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
