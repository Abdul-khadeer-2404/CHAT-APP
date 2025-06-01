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
const io = socketIO(server, {
    cors: {
        origin: process.env.NODE_ENV === 'production' ? false : ["http://localhost:3000"],
        methods: ["GET", "POST"]
    }
});

// Security middleware
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
            scriptSrc: ["'self'", "https://cdnjs.cloudflare.com"],
            imgSrc: ["'self'", "data:", "blob:"],
            fontSrc: ["'self'", "https://cdnjs.cloudflare.com"],
            connectSrc: ["'self'", "ws:", "wss:"],
        },
    },
}));

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per windowMs
    message: 'Too many requests from this IP, please try again later.',
    standardHeaders: true,
    legacyHeaders: false,
});

const uploadLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10, // limit each IP to 10 uploads per windowMs
    message: 'Too many file uploads, please try again later.',
});

app.use(limiter);

// Message rate limiting per socket
const messageLimiter = new Map();
const MESSAGE_LIMIT = 30; // messages per minute
const MESSAGE_WINDOW = 60 * 1000; // 1 minute

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
    // Allow only alphanumeric characters, spaces, and basic punctuation
    const validPattern = /^[a-zA-Z0-9\s\-_\.]+$/;
    return validPattern.test(username);
}

function validateMessage(message) {
    if (!message || typeof message !== 'string') return false;
    if (message.length > 500) return false;
    return true;
}

function sanitizeMessage(message) {
    // Remove XSS attempts and sanitize HTML
    return xss(message, {
        whiteList: {}, // No HTML tags allowed
        stripIgnoreTag: true,
        stripIgnoreTagBody: ['script']
    });
}

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

// Enhanced file validation
const ALLOWED_MIME_TYPES = {
    // Images
    'image/jpeg': ['.jpg', '.jpeg'],
    'image/png': ['.png'],
    'image/gif': ['.gif'],
    'image/webp': ['.webp'],
    // Videos
    'video/mp4': ['.mp4'],
    'video/webm': ['.webm'],
    'video/quicktime': ['.mov'],
    // Documents
    'application/pdf': ['.pdf'],
    'text/plain': ['.txt'],
    'application/msword': ['.doc'],
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
    // Archives
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
        cb(null, uploadsDir);
    },
    filename: (req, file, cb) => {
        // Generate secure filename
        const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9\-_.]/g, '');
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const extension = path.extname(sanitizedName);
        cb(null, `${uniqueSuffix}${extension}`);
    }
});

const upload = multer({
    storage: storage,
    limits: {
        fileSize: 10 * 1024 * 1024, // Reduced to 10MB for better security
        files: 1,
        fieldSize: 1024 * 1024, // 1MB field size limit
    },
    fileFilter: (req, file, cb) => {
        // Validate file type
        if (!validateFileType(file)) {
            return cb(new Error('Invalid file type'));
        }
        
        // Check filename length
        if (file.originalname.length > 100) {
            return cb(new Error('Filename too long'));
        }
        
        cb(null, true);
    }
});

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// File upload endpoint with additional security
app.post('/upload', uploadLimiter, upload.single('file'), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        const fileInfo = {
            filename: req.file.filename,
            originalname: path.basename(req.file.originalname), // Remove directory traversal
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

// Store connected users with additional info
const users = new Map();
const BANNED_USERNAMES = ['admin', 'moderator', 'system', 'bot', 'null', 'undefined'];

// Handle socket connections
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);
    
    let connectionValidated = false;
    
    // Timeout for connection validation
    const validationTimeout = setTimeout(() => {
        if (!connectionValidated) {
            socket.disconnect(true);
        }
    }, 30000); // 30 seconds to validate

    // Handle user joining with validation
    socket.on('join', (username) => {
        try {
            // Clear validation timeout
            clearTimeout(validationTimeout);
            
            // Validate username
            if (!validateUsername(username)) {
                socket.emit('error', 'Invalid username');
                return;
            }
            
            const cleanUsername = sanitizeMessage(username.trim());
            
            // Check for banned usernames
            if (BANNED_USERNAMES.includes(cleanUsername.toLowerCase())) {
                socket.emit('error', 'Username not allowed');
                return;
            }
            
            // Check if username already exists
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
            
            // Send current users list to all clients
            io.emit('users list', Array.from(users.values()).map(user => user.username));
            console.log(`${cleanUsername} joined the chat`);
        } catch (error) {
            console.error('Join error:', error);
            socket.emit('error', 'Failed to join chat');
        }
    });

    // Handle chat messages with enhanced security
    socket.on('chat message', (data) => {
        try {
            const userInfo = users.get(socket.id);
            if (!userInfo || !connectionValidated) {
                return;
            }
            
            // Rate limiting
            if (!checkMessageRate(socket.id)) {
                socket.emit('error', 'Too many messages. Please slow down.');
                return;
            }
            
            // Validate message
            if (!validateMessage(data.message)) {
                socket.emit('error', 'Invalid message');
                return;
            }
            
            const sanitizedMessage = sanitizeMessage(data.message);
            
            // Update user message count
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

    // Handle file messages
    socket.on('file message', (data) => {
        try {
            const userInfo = users.get(socket.id);
            if (!userInfo || !connectionValidated) {
                return;
            }
            
            // Rate limiting for file messages
            if (!checkMessageRate(socket.id)) {
                socket.emit('error', 'Too many messages. Please slow down.');
                return;
            }
            
            // Validate optional message
            let sanitizedMessage = '';
            if (data.message && validateMessage(data.message)) {
                sanitizedMessage = sanitizeMessage(data.message);
            }
            
            // Basic file validation
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

    // Handle typing indicators with rate limiting
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

    // Handle user disconnect
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
            
            // Send updated users list to all clients
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

// Cleanup old uploaded files (run every hour)
setInterval(() => {
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours
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
}, 60 * 60 * 1000); // Run every hour

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Visit http://localhost:${PORT} to access the chat`);
});