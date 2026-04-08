-- Vibepress Platform Database Schema
-- Chạy tự động khi MySQL container khởi động lần đầu

CREATE DATABASE IF NOT EXISTS `vibepress` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE `vibepress`;

-- -------------------------------------------------------
-- users: tài khoản Vibepress
-- api_key dùng để xác thực từ WP plugin (thay cho connectToken riêng)
-- -------------------------------------------------------
CREATE TABLE IF NOT EXISTS `users` (
  `id`            VARCHAR(36)   NOT NULL,
  `email`         VARCHAR(255)  NOT NULL,
  `password_hash` VARCHAR(255)  NOT NULL,
  `api_key`       VARCHAR(64)   NOT NULL,
  `created_at`    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_users_email`   (`email`),
  UNIQUE KEY `uq_users_api_key` (`api_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -------------------------------------------------------
-- wp_sites: mỗi WordPress site kết nối với Vibepress
-- user_id → users.id (một user có thể có nhiều site)
-- cloned_db / last_sync lưu JSON để linh hoạt, không cần migrate khi schema thay đổi
-- -------------------------------------------------------
CREATE TABLE IF NOT EXISTS `wp_sites` (
  `site_id`       VARCHAR(64)   NOT NULL,
  `user_id`       VARCHAR(36)       NULL  COMMENT 'NULL cho đến khi auth được implement (bước 4)',
  `site_url`      VARCHAR(512)  NOT NULL,
  `site_name`     VARCHAR(255)      NULL,
  `wp_version`    VARCHAR(20)       NULL,
  `admin_email`   VARCHAR(255)      NULL,
  `api_key`       VARCHAR(64)   NOT NULL  COMMENT 'key của user, dùng để auth từ plugin',
  `wp_repo_name`  VARCHAR(255)      NULL,
  `wp_repo_url`   VARCHAR(512)      NULL,
  `cloned_db`     JSON              NULL  COMMENT 'Railway DB info: host, port, dbName, password...',
  `last_sync`     JSON              NULL  COMMENT 'Kết quả sync gần nhất: synced, success, syncedAt...',
  `registered_at` DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`site_id`),
  UNIQUE KEY `uq_wp_sites_url` (`site_url`(255)),
  KEY `idx_wp_sites_user_id` (`user_id`),
  KEY `idx_wp_sites_api_key` (`api_key`),
  CONSTRAINT `fk_wp_sites_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
