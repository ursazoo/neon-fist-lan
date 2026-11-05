export const CHARACTERS = Object.freeze([
  { id: 'deepseek', name: 'DeepSeek', color: '#648cff', image: 'assets/fighters/deepseek.png' },
  { id: 'claude', name: 'Claude', color: '#df9778', image: 'assets/fighters/claude.png' },
  { id: 'chatgpt', name: 'ChatGPT', color: '#c4b0ee', image: 'assets/fighters/chatgpt.png' }
].map(character => Object.freeze(character)));

export const isCharacter = id => CHARACTERS.some(character => character.id === id);
