/**
 * cache_manager.js
 * 
 * Sistema de cache opcional para melhorar ainda mais a performance
 * Pode usar Redis ou cache em memória local
 */

class CacheManager {
  constructor(useRedis = false) {
    this.useRedis = useRedis;
    this.localCache = new Map();
    this.redis = null;
    
    if (useRedis) {
      try {
        const redis = require('redis');
        this.redis = redis.createClient({
          host: process.env.REDIS_HOST || 'localhost',
          port: process.env.REDIS_PORT || 6379,
          password: process.env.REDIS_PASSWORD || undefined
        });
        
        this.redis.on('error', (err) => {
          console.warn('Redis error, falling back to local cache:', err);
          this.useRedis = false;
        });
      } catch (error) {
        console.warn('Redis não disponível, usando cache local');
        this.useRedis = false;
      }
    }
  }

  async get(key) {
    if (this.useRedis && this.redis) {
      try {
        const value = await this.redis.get(key);
        return value ? JSON.parse(value) : null;
      } catch (error) {
        console.warn('Redis get error:', error);
        return this.localCache.get(key) || null;
      }
    }
    return this.localCache.get(key) || null;
  }

  async set(key, value, ttl = 3600) {
    if (this.useRedis && this.redis) {
      try {
        await this.redis.setex(key, ttl, JSON.stringify(value));
      } catch (error) {
        console.warn('Redis set error:', error);
      }
    }
    
    // Sempre manter cache local como backup
    this.localCache.set(key, value);
    
    // Limpar cache local após TTL
    setTimeout(() => {
      this.localCache.delete(key);
    }, ttl * 1000);
  }

  async del(key) {
    if (this.useRedis && this.redis) {
      try {
        await this.redis.del(key);
      } catch (error) {
        console.warn('Redis del error:', error);
      }
    }
    this.localCache.delete(key);
  }

  async clear() {
    if (this.useRedis && this.redis) {
      try {
        await this.redis.flushdb();
      } catch (error) {
        console.warn('Redis clear error:', error);
      }
    }
    this.localCache.clear();
  }

  // Método para gerar chaves de cache consistentes
  static generateKey(prefix, ...params) {
    return `${prefix}:${params.join(':')}`;
  }

  // Método para cache com função de fallback
  async getOrSet(key, fallbackFunction, ttl = 3600) {
    let cached = await this.get(key);
    
    if (cached !== null) {
      return cached;
    }
    
    const result = await fallbackFunction();
    await this.set(key, result, ttl);
    return result;
  }

  // Estatísticas do cache
  getStats() {
    return {
      localCacheSize: this.localCache.size,
      redisEnabled: this.useRedis,
      redisConnected: this.redis ? this.redis.connected : false
    };
  }
}

module.exports = CacheManager;
