import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/** Marca uma rota (ou controller) como pública: o AuthGuard não exige sessão. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
