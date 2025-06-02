const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const xss = require('xss');

const app = express();
const server = http.createServer(app);

// Updated Socket.IO configuration for Railway
const io = socketIO(server, {
    cors: {
        origin: "*", // Allow all origins for Railway
        methods: ["GET", "POST"],
        credentials: true
    },
    transports: ['websocket', 'polling'],
    allowEIO3: true,
    connectTimeout: 60000,
    pingTimeout: 60000,
    pingInterval: 25000
});

// Security middleware - Updated for Railway
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
            scriptSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
            imgSrc: ["'self'", "data:", "blob:"],
            fontSrc: ["'self'", "https://cdnjs.cloudflare.com"],
            connectSrc: ["'self'", "ws:", "wss:"],
        },
    },
}));

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: 'Too many requests from this IP, please try again later.',
    standardHeaders: true,
    legacyHeaders: false,
});

const uploadLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: 'Too many file uploads, please try again later.',
});

app.use(limiter);

// Middleware to parse JSON
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Create public directory structure
const publicDir = path.join(__dirname, 'public');
const uploadsDir = path.join(publicDir, 'uploads');

// Ensure directories exist
[publicDir, uploadsDir].forEach(dir => {
    if (!fs.existsSync(dir)) {
        try {
            fs.mkdirSync(dir, { recursive: true });
            console.log(`Created directory: ${dir}`);
        } catch (error) {
            console.warn(`Could not create directory ${dir}:`, error.message);
        }
    }
});

// Serve static files - IMPORTANT: This must come before other routes
app.use(express.static(publicDir));
app.use('/uploads', express.static(uploadsDir));

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        port: process.env.PORT || 3000
    });
});

// ROOT ROUTE - This was missing!
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Message rate limiting per socket
const messageLimiter = new Map();
const MESSAGE_LIMIT = 30;
const MESSAGE_WINDOW = 60 * 1000;

function checkMessageRate(socketId) {
    const now = Date.now();
    const userLimits = messageLimiter.get(socketId) || { count: 0, resetTime: now + MESSAGE_WINDOW };
    
    if (now > userLimits.resetTime) {
        userLimits.count = 0;
        userLimits.resetTime = now + MESSAGE_WINDOW;
    }
    
    userLimits.count++;
    messageLimiter.set(socketId, userLimits);
    
    return userLimits.count <= MESSAGE_LIMIT;
}

// Input validation and sanitization
function validateUsername(username) {
    if (!username || typeof username !== 'string') return false;
    if (username.length < 2 || username.length > 20) return false;
    const validPattern = /^[a-zA-Z0-9\s\-_\.]+$/;
    return validPattern.test(username);
}

function validateMessage(message) {
    if (!message || typeof message !== 'string') return false;
    if (message.length > 500) return false;
    return true;
}

function sanitizeMessage(message) {
    return xss(message, {
        whiteList: {},
        stripIgnoreTag: true,
        stripIgnoreTagBody: ['script']
    });
}

// Enhanced file validation
const ALLOWED_MIME_TYPES = {
    'image/jpeg': ['.jpg', '.jpeg'],
    'image/png': ['.png'],
    'image/gif': ['.gif'],
    'image/webp': ['.webp'],
    'video/mp4': ['.mp4'],
    'video/webm': ['.webm'],
    'video/quicktime': ['.mov'],
    'application/pdf': ['.pdf'],
    'text/plain': ['.txt'],
    'application/msword': ['.doc'],
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
    'application/zip': ['.zip'],
    'application/x-rar-compressed': ['.rar']
};

function validateFileType(file) {
    const allowedExtensions = ALLOWED_MIME_TYPES[file.mimetype];
    if (!allowedExtensions) return false;
    
    const fileExtension = path.extname(file.originalname).toLowerCase();
    return allowedExtensions.includes(fileExtension);
}

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        try {
            if (!fs.existsSync(uploadsDir)) {
                fs.mkdirSync(uploadsDir, { recursive: true });
            }
            cb(null, uploadsDir);
        } catch (error) {
            console.error('Upload directory error:', error);
            cb(error);
        }
    },
    filename: (req, file, cb) => {
        const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9\-_.]/g, '');
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const extension = path.extname(sanitizedName);
        cb(null, `${uniqueSuffix}${extension}`);
    }
});

const upload = multer({
    storage: storage,
    limits: {
        fileSize: 10 * 1024 * 1024,
        files: 1,
        fieldSize: 1024 * 1024,
    },
    fileFilter: (req, file, cb) => {
        if (!validateFileType(file)) {
            return cb(new Error('Invalid file type'));
        }
        
        if (file.originalname.length > 100) {
            return cb(new Error('Filename too long'));
        }
        
        cb(null, true);
    }
});

// File upload endpoint
app.post('/upload', uploadLimiter, upload.single('file'), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        const fileInfo = {
            filename: req.file.filename,
            originalname: path.basename(req.file.originalname),
            mimetype: req.file.mimetype,
            size: req.file.size,
            url: `/uploads/${req.file.filename}`
        };

        res.json({ success: true, file: fileInfo });
    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ error: 'Upload failed' });
    }
});

// Store connected users
const users = new Map();
const BANNED_USERNAMES = ['admin', 'moderator', 'system', 'bot', 'null', 'undefined'];

// Handle socket connections
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);
    
    let connectionValidated = false;
    
    const validationTimeout = setTimeout(() => {
        if (!connectionValidated) {
            socket.disconnect(true);
        }
    }, 30000);

    socket.on('join', (username) => {
        try {
            clearTimeout(validationTimeout);
            
            if (!validateUsername(username)) {
                socket.emit('error', 'Invalid username');
                return;
            }
            
            const cleanUsername = sanitizeMessage(username.trim());
            
            if (BANNED_USERNAMES.includes(cleanUsername.toLowerCase())) {
                socket.emit('error', 'Username not allowed');
                return;
            }
            
            const existingUsers = Array.from(users.values());
            if (existingUsers.some(user => user.username.toLowerCase() === cleanUsername.toLowerCase())) {
                socket.emit('error', 'Username already taken');
                return;
            }
            
            connectionValidated = true;
            users.set(socket.id, {
                username: cleanUsername,
                joinTime: Date.now(),
                messageCount: 0
            });
            
            socket.broadcast.emit('user joined', {
                username: cleanUsername,
                message: `${cleanUsername} joined the chat`,
                timestamp: new Date().toLocaleTimeString()
            });
            
            io.emit('users list', Array.from(users.values()).map(user => user.username));
            console.log(`${cleanUsername} joined the chat`);
        } catch (error) {
            console.error('Join error:', error);
            socket.emit('error', 'Failed to join chat');
        }
    });

    socket.on('chat message', (data) => {
        try {
            const userInfo = users.get(socket.id);
            if (!userInfo || !connectionValidated) {
                return;
            }
            
            if (!checkMessageRate(socket.id)) {
                socket.emit('error', 'Too many messages. Please slow down.');
                return;
            }
            
            if (!validateMessage(data.message)) {
                socket.emit('error', 'Invalid message');
                return;
            }
            
            const sanitizedMessage = sanitizeMessage(data.message);
            
            userInfo.messageCount++;
            
            io.emit('chat message', {
                username: userInfo.username,
                message: sanitizedMessage,
                messageType: data.messageType || 'text',
                file: data.file || null,
                timestamp: new Date().toLocaleTimeString()
            });
        } catch (error) {
            console.error('Message error:', error);
            socket.emit('error', 'Failed to send message');
        }
    });

    socket.on('file message', (data) => {
        try {
            const userInfo = users.get(socket.id);
            if (!userInfo || !connectionValidated) {
                return;
            }
            
            if (!checkMessageRate(socket.id)) {
                socket.emit('error', 'Too many messages. Please slow down.');
                return;
            }
            
            let sanitizedMessage = '';
            if (data.message && validateMessage(data.message)) {
                sanitizedMessage = sanitizeMessage(data.message);
            }
            
            if (!data.file || !data.file.filename || !data.file.url) {
                socket.emit('error', 'Invalid file data');
                return;
            }
            
            userInfo.messageCount++;
            
            io.emit('chat message', {
                username: userInfo.username,
                message: sanitizedMessage,
                messageType: 'file',
                file: data.file,
                timestamp: new Date().toLocaleTimeString()
            });
        } catch (error) {
            console.error('File message error:', error);
            socket.emit('error', 'Failed to send file');
        }
    });

    socket.on('typing', () => {
        const userInfo = users.get(socket.id);
        if (userInfo && connectionValidated) {
            socket.broadcast.emit('user typing', userInfo.username);
        }
    });

    socket.on('stop typing', () => {
        if (connectionValidated) {
            socket.broadcast.emit('user stop typing');
        }
    });

    socket.on('disconnect', () => {
        const userInfo = users.get(socket.id);
        if (userInfo) {
            users.delete(socket.id);
            messageLimiter.delete(socket.id);
            
            socket.broadcast.emit('user left', {
                username: userInfo.username,
                message: `${userInfo.username} left the chat`,
                timestamp: new Date().toLocaleTimeString()
            });
            
            io.emit('users list', Array.from(users.values()).map(user => user.username));
            console.log(`${userInfo.username} left the chat`);
        }
        clearTimeout(validationTimeout);
    });
});

// Error handling middleware
app.use((error, req, res, next) => {
    if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({ error: 'File too large. Maximum size is 10MB.' });
        }
        if (error.code === 'LIMIT_FILE_COUNT') {
            return res.status(400).json({ error: 'Too many files.' });
        }
    }
    console.error('Server error:', error);
    res.status(500).json({ error: 'Server error occurred' });
});

// Cleanup old files
const cleanupInterval = setInterval(() => {
    try {
        if (!fs.existsSync(uploadsDir)) return;
        
        const maxAge = 24 * 60 * 60 * 1000;
        const now = Date.now();
        
        fs.readdir(uploadsDir, (err, files) => {
            if (err) return;
            
            files.forEach(file => {
                const filePath = path.join(uploadsDir, file);
                fs.stat(filePath, (err, stats) => {
                    if (err) return;
                    
                    if (now - stats.mtime.getTime() > maxAge) {
                        fs.unlink(filePath, (err) => {
                            if (!err) console.log(`Cleaned up old file: ${file}`);
                        });
                    }
                });
            });
        });
    } catch (error) {
        console.error('Cleanup error:', error);
    }
}, 60 * 60 * 1000);

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully');
    clearInterval(cleanupInterval);
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', (err) => {
    if (err) {
        console.error('Failed to start server:', err);
        process.exit(1);
    }
    console.log(`Server running on port ${PORT}`);
    console.log(`Chat app: http://localhost:${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
});