FROM node:22

# Install Salesforce CLI
RUN npm install -g @salesforce/cli

# Verify installation
RUN sf --version

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

EXPOSE 10000

CMD ["npm", "start"]