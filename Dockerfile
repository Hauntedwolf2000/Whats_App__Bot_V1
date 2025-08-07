# Use the official Node.js 18 image
FROM node:18-slim

# Install necessary packages for Puppeteer and Chrome
RUN apt-get update \
    && apt-get install -y wget gnupg \
    && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/googlechrome-linux-keyring.gpg \
    && sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' \
    && apt-get update \
    && apt-get install -y google-chrome-stable fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-khmeros fonts-kacst fonts-freefont-ttf libxss1 libx11-xcb1 libxcomposite1 libxcursor1 libxdamage1 libxi-dev libxtst-dev libnss3-dev libxss-dev libxrandr2 libasound2-dev libpangocairo-1.0-0 libatk1.0-dev libcairo-gobject2 libgtk-3-dev libgdk-pixbuf2.0-dev \
      --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /usr/src/app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production && npm cache clean --force

# Copy app source
COPY . .

# Create directory for WhatsApp session data
RUN mkdir -p .wwebjs_auth && chmod 755 .wwebjs_auth
RUN mkdir -p .wwebjs_cache && chmod 755 .wwebjs_cache

# Set proper permissions
RUN chown -R node:node /usr/src/app

# Switch to non-root user
USER node

# Expose port
EXPOSE 3000

# Set Puppeteer to use installed Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable
ENV NODE_ENV=production

# Start the application
CMD ["npm", "start"]