FROM ghcr.io/puppeteer/puppeteer:24.0.0

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of your code
COPY . .

# Expose port (Render will override)
EXPOSE 7000

# Start your addon
CMD ["npm", "start"]