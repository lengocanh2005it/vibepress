import {
  Body,
  Controller,
  Post,
  UploadedFile,
  UploadedFiles,
  UseInterceptors,
  BadRequestException,
} from '@nestjs/common';
import {
  FileInterceptor,
  FileFieldsInterceptor,
} from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { ImportService } from './import.service.js';
import type { WpDbCredentials } from '@/common/types/db-credentials.type.js';

export interface ImportDirectDbDto {
  host: string;
  port: number;
  dbName: string;
  user: string;
  password: string;
}

export interface ImportGithubDto {
  repoUrl: string;
  accessToken?: string;
  branch?: string;
}

@Controller('import')
export class ImportController {
  constructor(private readonly importService: ImportService) {}

  // Mode A: Upload file .sql
  @Post('sql')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: './temp/uploads',
        filename: (_req, file, cb) =>
          cb(null, `${uuidv4()}${extname(file.originalname)}`),
      }),
      fileFilter: (_req, file, cb) => {
        if (extname(file.originalname).toLowerCase() !== '.sql')
          return cb(
            new BadRequestException('Only .sql files are allowed'),
            false,
          );
        cb(null, true);
      },
    }),
  )
  async importSql(@UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException('No file uploaded');
    return this.importService.handleSqlUpload(file.path);
  }

  // Mode B: Kết nối trực tiếp vào WP database
  @Post('db')
  async importDirectDb(@Body() dto: ImportDirectDbDto) {
    const creds: WpDbCredentials = {
      host: dto.host,
      port: Number(dto.port),
      dbName: dto.dbName,
      user: dto.user,
      password: dto.password,
    };
    return this.importService.handleDirectDb(creds);
  }

  // Mode D: Clone từ GitHub repo (nguồn theme chính)
  @Post('github')
  async importGithub(@Body() dto: ImportGithubDto) {
    if (!dto.repoUrl) throw new BadRequestException('repoUrl is required');
    return this.importService.handleGithubImport(
      dto.repoUrl,
      dto.accessToken,
      dto.branch,
    );
  }

  // Mode Full: upload SQL + theme zip cùng lúc → auto detect active theme
  @Post('full')
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'sql', maxCount: 1 },
        { name: 'theme', maxCount: 1 },
      ],
      {
        storage: diskStorage({
          destination: './temp/uploads',
          filename: (_req, file, cb) =>
            cb(null, `${uuidv4()}${extname(file.originalname)}`),
        }),
      },
    ),
  )
  async importFull(
    @UploadedFiles()
    files: {
      sql?: Express.Multer.File[];
      theme?: Express.Multer.File[];
    },
  ) {
    if (!files?.sql?.[0]) throw new BadRequestException('sql file is required');
    if (!files?.theme?.[0])
      throw new BadRequestException('theme file is required');
    return this.importService.handleFullImport(
      files.sql[0].path,
      files.theme[0].path,
    );
  }

  // Upload theme .zip (dự phòng khi không có GitHub)
  @Post('theme')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: './temp/uploads',
        filename: (_req, file, cb) =>
          cb(null, `${uuidv4()}${extname(file.originalname)}`),
      }),
      fileFilter: (_req, file, cb) => {
        const ext = extname(file.originalname).toLowerCase();
        if (!['.zip', '.gz'].includes(ext))
          return cb(
            new BadRequestException('Only .zip or .tar.gz files are allowed'),
            false,
          );
        cb(null, true);
      },
    }),
  )
  async importTheme(@UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException('No file uploaded');
    return this.importService.handleThemeUpload(file.path);
  }
}
