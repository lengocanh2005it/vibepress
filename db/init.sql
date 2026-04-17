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

-- -------------------------------------------------------
-- wp_site_members: quan hệ nhiều-nhiều user ↔ site
-- owner = người đăng ký đầu tiên, member = người connect sau
-- -------------------------------------------------------
CREATE TABLE IF NOT EXISTS `wp_site_members` (
  `site_id`   VARCHAR(64)  NOT NULL,
  `user_id`   VARCHAR(36)  NOT NULL,
  `joined_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`site_id`, `user_id`),
  CONSTRAINT `fk_wsm_site` FOREIGN KEY (`site_id`) REFERENCES `wp_sites` (`site_id`) ON DELETE CASCADE,
  CONSTRAINT `fk_wsm_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)          ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -------------------------------------------------------
-- wp_presets: các WordPress site được cấu hình sẵn (preset)
-- dùng để nạp nhanh thông tin đăng nhập và URL vào editor
-- -------------------------------------------------------
CREATE TABLE IF NOT EXISTS `wp_presets` (
  `id`           VARCHAR(36)   NOT NULL,
  `site_name`    VARCHAR(255)  NOT NULL  COMMENT 'Tên hiển thị của site',
  `username`     VARCHAR(255)  NOT NULL  COMMENT 'Tài khoản đăng nhập WordPress',
  `password`     VARCHAR(255)  NOT NULL  COMMENT 'Mật khẩu đăng nhập WordPress',
  `url_page`     VARCHAR(512)  NOT NULL  COMMENT 'URL trang front-end của site',
  `url_wpadmin`  VARCHAR(512)  NOT NULL  COMMENT 'URL trang wp-admin của site',
  `created_at`   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `description`  TEXT          NULL  COMMENT 'Mô tả thêm về preset này',
  `image_url`    TEXT  NULL  COMMENT 'URL ảnh đại diện cho site (nếu có)',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_wp_presets_url_page` (`url_page`(255))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -------------------------------------------------------
-- captures: ảnh chụp màn hình do người dùng tạo kèm comment chỉnh sửa
-- site_id → wp_sites.site_id
-- -------------------------------------------------------
CREATE TABLE IF NOT EXISTS `captures` (
  `id`                      VARCHAR(64)    NOT NULL,
  `site_id`                 VARCHAR(64)    NOT NULL,

  -- file
  `file_path`               VARCHAR(512)       NULL,
  `file_name`               VARCHAR(255)       NULL,

  -- asset (Cloudinary / storage provider info)
  `asset`                  JSON               NULL,

  -- context
  `comment`                 TEXT               NULL  COMMENT 'Yêu cầu chỉnh sửa của người dùng',
  `page_url`                VARCHAR(512)       NULL,
  `iframe_src`              VARCHAR(1024)      NULL,
  `captured_at`             DATETIME       NOT NULL,

  -- viewport
  `viewport`                JSON               NULL  COMMENT 'width, height, scrollX, scrollY, dpr',

  -- page
  `page`                    JSON               NULL,

  -- selection & geometry (coordinate data, stored as JSON)
  `selection`               JSON               NULL  COMMENT 'x, y, width, height, coordinateSpace',
  `geometry`                JSON               NULL  COMMENT 'viewportRect, documentRect, normalizedRect',

  -- DOM target (full selector / path info)
  `dom_target`              JSON               NULL  COMMENT 'cssSelector, xpath, tagName, classNames, htmlSnippet...',

  -- target node (block / template context)
  `target_node`    JSON               NULL,


  `created_at`              DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`              DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (`id`),
  KEY `idx_captures_site_id`    (`site_id`),
  KEY `idx_captures_captured_at` (`captured_at`),
  CONSTRAINT `fk_captures_site` FOREIGN KEY (`site_id`) REFERENCES `wp_sites` (`site_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
