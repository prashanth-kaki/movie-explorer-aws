FROM node:18

WORKDIR /app

# Copy dependency files
COPY package*.json ./

# Install exact dependencies
RUN npm ci --only=production

# Copy application source
COPY . .

# Expose application port
EXPOSE 3000

# Start the application
CMD ["node", "server.js"]
