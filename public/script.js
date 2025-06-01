// Initialize socket connection
const socket = io();

// DOM elements
const loginForm = document.getElementById('loginForm');
const chatInterface = document.getElementById('chatInterface');
const usernameInput = document.getElementById('usernameInput');
const joinBtn = document.getElementById('joinBtn');
const leaveBtn = document.getElementById('leaveBtn');
const currentUser = document.getElementById('currentUser');
const usersList = document.getElementById('usersList');
const messages = document.getElementById('messages');
const messageInput = document.getElementById('messageInput');
const sendBtn = document.getElementById('sendBtn');
const fileInput = document.getElementById('fileInput');
const fileBtn = document.getElementById('fileBtn');
const typingIndicator = document.getElementById('typingIndicator');
const filePreview = document.getElementById('filePreview');
const cancelFileBtn = document.getElementById('cancelFileBtn');
const uploadProgress = document.getElementById('uploadProgress');

// State variables
let username = '';
let isTyping = false;
let typingTimer;
let selectedFile = null;

// Event listeners
joinBtn.addEventListener('click', joinChat);
leaveBtn.addEventListener('click', leaveChat);
sendBtn.addEventListener('click', sendMessage);
fileBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', handleFileSelect);
cancelFileBtn.addEventListener('click', cancelFileSelection);
messageInput.addEventListener('keypress', handleMessageInput);
messageInput.addEventListener('input', handleTyping);
usernameInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') joinChat();
});

// Join chat function
function joinChat() {
    const inputUsername = usernameInput.value.trim();
    
    if (inputUsername.length < 2) {
        alert('Username must be at least 2 characters long');
        return;
    }
    
    if (inputUsername.length > 20) {
        alert('Username must be less than 20 characters');
        return;
    }
    
    username = inputUsername;
    socket.emit('join', username);
    
    // Switch to chat interface
    loginForm.classList.add('hidden');
    chatInterface.classList.remove('hidden');
    currentUser.textContent = username;
    messageInput.focus();
}

// Leave chat function
function leaveChat() {
    if (confirm('Are you sure you want to leave the chat?')) {
        socket.disconnect();
        location.reload();
    }
}

// Handle file selection
function handleFileSelect(e) {
    const file = e.target.files[0];
    if (!file) return;

    // Check file size (50MB limit)
    if (file.size > 50 * 1024 * 1024) {
        alert('File size must be less than 50MB');
        return;
    }

    selectedFile = file;
    showFilePreview(file);
}

// Show file preview
function showFilePreview(file) {
    const fileName = document.getElementById('fileName');
    const fileSize = document.getElementById('fileSize');
    const previewImage = document.getElementById('previewImage');

    fileName.textContent = file.name;
    fileSize.textContent = formatFileSize(file.size);

    // Show image preview if it's an image
    if (file.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = (e) => {
            previewImage.src = e.target.result;
            previewImage.style.display = 'block';
        };
        reader.readAsDataURL(file);
    } else {
        previewImage.style.display = 'none';
    }

    filePreview.classList.remove('hidden');
    messageInput.placeholder = 'Add a message (optional)...';
}

// Cancel file selection
function cancelFileSelection() {
    selectedFile = null;
    fileInput.value = '';
    filePreview.classList.add('hidden');
    messageInput.placeholder = 'Type your message...';
}

// Upload file
async function uploadFile(file) {
    const formData = new FormData();
    formData.append('file', file);

    try {
        uploadProgress.classList.remove('hidden');
        
        const response = await fetch('/upload', {
            method: 'POST',
            body: formData
        });

        const result = await response.json();
        
        if (result.success) {
            return result.file;
        } else {
            throw new Error(result.error || 'Upload failed');
        }
    } catch (error) {
        console.error('Upload error:', error);
        alert('File upload failed: ' + error.message);
        return null;
    } finally {
        uploadProgress.classList.add('hidden');
    }
}

// Send message function
async function sendMessage() {
    const message = messageInput.value.trim();
    
    if (!selectedFile && message === '') return;

    // Disable send button during upload
    sendBtn.disabled = true;
    sendBtn.textContent = 'Sending...';

    try {
        if (selectedFile) {
            // Upload file first
            const fileInfo = await uploadFile(selectedFile);
            if (fileInfo) {
                socket.emit('file message', {
                    message: message,
                    file: fileInfo
                });
            }
            cancelFileSelection();
        } else {
            // Send text message
            socket.emit('chat message', { message });
        }

        messageInput.value = '';
        messageInput.focus();
        
        // Stop typing indicator
        if (isTyping) {
            socket.emit('stop typing');
            isTyping = false;
        }
    } finally {
        sendBtn.disabled = false;
        sendBtn.textContent = 'Send';
    }
}

// Handle message input
function handleMessageInput(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
}

// Handle typing indicator
function handleTyping() {
    if (!isTyping) {
        isTyping = true;
        socket.emit('typing');
    }
    
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => {
        isTyping = false;
        socket.emit('stop typing');
    }, 1000);
}

// Display message in chat
function displayMessage(data, type = 'other') {
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${type}`;
    
    if (type === 'system') {
        messageDiv.innerHTML = `
            <div class="message-text">${data.message}</div>
            <div class="message-time">${data.timestamp}</div>
        `;
    } else {
        const isOwnMessage = data.username === username;
        messageDiv.className = `message ${isOwnMessage ? 'own' : 'other'}`;
        
        let messageContent = '';
        
        // Handle file messages
        if (data.messageType === 'file' && data.file) {
            messageContent += createFileMessage(data.file);
        }
        
        // Add text message if present
        if (data.message) {
            messageContent += `<div class="message-text">${escapeHtml(data.message)}</div>`;
        }
        
        messageDiv.innerHTML = `
            <div class="message-header">${data.username}</div>
            ${messageContent}
            <div class="message-time">${data.timestamp}</div>
        `;
    }
    
    messages.appendChild(messageDiv);
    scrollToBottom();
}

// Create file message content
function createFileMessage(file) {
    const fileUrl = file.url;
    const fileName = file.originalname;
    const fileSize = formatFileSize(file.size);
    const fileType = file.mimetype;

    if (fileType.startsWith('image/')) {
        return `
            <div class="file-message image-message">
                <img src="${fileUrl}" alt="${fileName}" class="message-image" onclick="openImageModal('${fileUrl}', '${fileName}')">
                <div class="file-info">
                    <span class="file-name">${fileName}</span>
                    <span class="file-size">${fileSize}</span>
                </div>
            </div>
        `;
    } else if (fileType.startsWith('video/')) {
        return `
            <div class="file-message video-message">
                <video controls class="message-video">
                    <source src="${fileUrl}" type="${fileType}">
                    Your browser does not support the video tag.
                </video>
                <div class="file-info">
                    <span class="file-name">${fileName}</span>
                    <span class="file-size">${fileSize}</span>
                </div>
            </div>
        `;
    } else {
        return `
            <div class="file-message document-message">
                <div class="file-icon">📄</div>
                <div class="file-details">
                    <a href="${fileUrl}" target="_blank" class="file-name">${fileName}</a>
                    <span class="file-size">${fileSize}</span>
                </div>
                <a href="${fileUrl}" download="${fileName}" class="download-btn"><i class="fas fa-download"></i></a>
            </div>
        `;
    }
}

// Open image modal
function openImageModal(src, fileName) {
    const modal = document.createElement('div');
    modal.className = 'image-modal';
    modal.innerHTML = `
        <div class="modal-content">
            <span class="close-modal">&times;</span>
            <img src="${src}" alt="${fileName}" class="modal-image">
            <div class="modal-caption">${fileName}</div>
        </div>
    `;
    
    document.body.appendChild(modal);
    
    // Close modal events
    modal.addEventListener('click', (e) => {
        if (e.target === modal || e.target.className === 'close-modal') {
            document.body.removeChild(modal);
        }
    });
    
    document.addEventListener('keydown', function escHandler(e) {
        if (e.key === 'Escape') {
            document.body.removeChild(modal);
            document.removeEventListener('keydown', escHandler);
        }
    });
}

// Format file size
function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Update users list
function updateUsersList(users) {
    usersList.innerHTML = '';
    users.forEach(user => {
        const li = document.createElement('li');
        li.textContent = user;
        if (user === username) {
            li.style.fontWeight = 'bold';
            li.style.color = '#667eea';
        }
        usersList.appendChild(li);
    });
}

// Scroll to bottom of messages
function scrollToBottom() {
    messages.scrollTop = messages.scrollHeight;
}

// Escape HTML to prevent XSS
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Socket event listeners
socket.on('chat message', (data) => {
    displayMessage(data);
});

socket.on('user joined', (data) => {
    displayMessage(data, 'system');
});

socket.on('user left', (data) => {
    displayMessage(data, 'system');
});

socket.on('users list', (users) => {
    updateUsersList(users);
});

socket.on('user typing', (username) => {
    typingIndicator.innerHTML = `<span class="typing-dots">${username} is typing</span>`;
});

socket.on('user stop typing', () => {
    typingIndicator.innerHTML = '';
});

socket.on('connect', () => {
    console.log('Connected to server');
});

socket.on('disconnect', () => {
    console.log('Disconnected from server');
    if (!loginForm.classList.contains('hidden')) {
        alert('Connection lost. Please refresh the page.');
    }
});

// Focus username input on page load
window.addEventListener('load', () => {
    usernameInput.focus();
});