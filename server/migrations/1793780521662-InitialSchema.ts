import { MigrationInterface, QueryRunner } from "typeorm";

export class InitialSchema1793780521662 implements MigrationInterface {
    name = 'InitialSchema1793780521662'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE "competitors" (
                "id" text NOT NULL,
                "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "next_poll_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                CONSTRAINT "PK_76a451dd0c8a51a0e0fb6284389" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE INDEX "competitors_next_poll_at_idx" ON "competitors" ("next_poll_at")
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."summary_status" AS ENUM('none', 'pending', 'done', 'failed')
        `);
        await queryRunner.query(`
            CREATE TABLE "snapshots" (
                "id" BIGSERIAL NOT NULL,
                "competitor_id" text NOT NULL,
                "fetched_at" TIMESTAMP WITH TIME ZONE NOT NULL,
                "title" text NOT NULL,
                "tagline" text NOT NULL,
                "price" text NOT NULL,
                "description" text NOT NULL,
                "content_hash" text NOT NULL,
                "changed" boolean NOT NULL,
                "summary" text,
                "summary_status" "public"."summary_status" NOT NULL DEFAULT 'none',
                "summary_attempts" integer NOT NULL DEFAULT '0',
                "summary_next_attempt_at" TIMESTAMP WITH TIME ZONE,
                "summary_error" text,
                "summary_provider" text,
                "summary_model" text,
                CONSTRAINT "PK_f5661b5fd4224d23e26a631986b" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE INDEX "snapshots_summary_due_idx" ON "snapshots" ("summary_next_attempt_at")
            WHERE summary_status = 'pending'
        `);
        await queryRunner.query(`
            CREATE INDEX "snapshots_competitor_id_id_idx" ON "snapshots" ("competitor_id", "id")
        `);
        await queryRunner.query(`
            CREATE TABLE "source_cursors" (
                "competitor_id" text NOT NULL,
                "position" integer NOT NULL DEFAULT '0',
                CONSTRAINT "PK_e270718e6f70f28d30254dfd82a" PRIMARY KEY ("competitor_id")
            )
        `);
        await queryRunner.query(`
            ALTER TABLE "snapshots"
            ADD CONSTRAINT "FK_4c88bf4c55ff4fa8268120d3c1d" FOREIGN KEY ("competitor_id") REFERENCES "competitors"("id") ON DELETE CASCADE ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "source_cursors"
            ADD CONSTRAINT "FK_e270718e6f70f28d30254dfd82a" FOREIGN KEY ("competitor_id") REFERENCES "competitors"("id") ON DELETE CASCADE ON UPDATE NO ACTION
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "source_cursors" DROP CONSTRAINT "FK_e270718e6f70f28d30254dfd82a"
        `);
        await queryRunner.query(`
            ALTER TABLE "snapshots" DROP CONSTRAINT "FK_4c88bf4c55ff4fa8268120d3c1d"
        `);
        await queryRunner.query(`
            DROP TABLE "source_cursors"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."snapshots_competitor_id_id_idx"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."snapshots_summary_due_idx"
        `);
        await queryRunner.query(`
            DROP TABLE "snapshots"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."summary_status"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."competitors_next_poll_at_idx"
        `);
        await queryRunner.query(`
            DROP TABLE "competitors"
        `);
    }

}
