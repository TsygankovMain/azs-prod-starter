<?php

declare(strict_types=1);

namespace DoctrineMigrations;

use Doctrine\DBAL\Schema\Schema;
use Doctrine\Migrations\AbstractMigration;

/**
 * Auto-generated Migration: Please modify to your needs!
 */
final class Version20251029140800 extends AbstractMigration
{
    public function getDescription(): string
    {
        return '';
    }

    public function up(Schema $schema): void
    {
        $platform = $this->connection->getDatabasePlatform()->getName();

        if ('mysql' === $platform) {
            $this->addSql('CREATE TABLE application_installation (id CHAR(36) NOT NULL, status VARCHAR(255) NOT NULL, created_at_utc DATETIME(3) NOT NULL COMMENT \'(DC2Type:datetime_immutable)\', update_at_utc DATETIME(3) NOT NULL COMMENT \'(DC2Type:datetime_immutable)\', bitrix_24_account_id CHAR(36) NOT NULL COMMENT \'(DC2Type:uuid)\', contact_person_id CHAR(36) DEFAULT NULL COMMENT \'(DC2Type:uuid)\', bitrix_24_partner_contact_person_id CHAR(36) DEFAULT NULL COMMENT \'(DC2Type:uuid)\', bitrix_24_partner_id CHAR(36) DEFAULT NULL COMMENT \'(DC2Type:uuid)\', external_id VARCHAR(255) DEFAULT NULL, portal_license_family VARCHAR(255) NOT NULL, portal_users_count INT DEFAULT NULL, application_token VARCHAR(255) DEFAULT NULL, comment LONGTEXT DEFAULT NULL, application_status_status_code JSON DEFAULT NULL, PRIMARY KEY(id)) DEFAULT CHARACTER SET utf8mb4 COLLATE `utf8mb4_unicode_ci` ENGINE = InnoDB');
            $this->addSql('CREATE UNIQUE INDEX UNIQ_BFAFA1E89245A62F ON application_installation (bitrix_24_account_id)');
            $this->addSql('CREATE TABLE bitrix24account (id CHAR(36) NOT NULL COMMENT \'(DC2Type:uuid)\', b24_user_id INT NOT NULL, is_b24_user_admin TINYINT(1) NOT NULL, member_id VARCHAR(255) NOT NULL, is_master_account TINYINT(1) DEFAULT NULL, domain_url VARCHAR(255) NOT NULL, status VARCHAR(255) NOT NULL, application_token VARCHAR(255) DEFAULT NULL, created_at_utc DATETIME(3) NOT NULL COMMENT \'(DC2Type:datetime_immutable)\', updated_at_utc DATETIME(3) NOT NULL COMMENT \'(DC2Type:datetime_immutable)\', application_version INT NOT NULL, comment LONGTEXT DEFAULT NULL, auth_token_access_token VARCHAR(255) NOT NULL, auth_token_refresh_token VARCHAR(255) NOT NULL, auth_token_expires BIGINT NOT NULL, auth_token_expires_in INT DEFAULT NULL, application_scope_current_scope JSON DEFAULT NULL, PRIMARY KEY(id)) DEFAULT CHARACTER SET utf8mb4 COLLATE `utf8mb4_unicode_ci` ENGINE = InnoDB');

            return;
        }

        $this->addSql('CREATE TABLE application_installation (id UUID NOT NULL, status VARCHAR(255) NOT NULL, created_at_utc TIMESTAMP(3) WITHOUT TIME ZONE NOT NULL, update_at_utc TIMESTAMP(3) WITHOUT TIME ZONE NOT NULL, bitrix_24_account_id UUID NOT NULL, contact_person_id UUID DEFAULT NULL, bitrix_24_partner_contact_person_id UUID DEFAULT NULL, bitrix_24_partner_id UUID DEFAULT NULL, external_id VARCHAR(255) DEFAULT NULL, portal_license_family VARCHAR(255) NOT NULL, portal_users_count INT DEFAULT NULL, application_token VARCHAR(255) DEFAULT NULL, comment TEXT DEFAULT NULL, application_status_status_code JSON DEFAULT NULL, PRIMARY KEY(id))');
        $this->addSql('CREATE UNIQUE INDEX UNIQ_BFAFA1E89245A62F ON application_installation (bitrix_24_account_id)');
        $this->addSql('COMMENT ON COLUMN application_installation.id IS \'(DC2Type:uuid)\'');
        $this->addSql('COMMENT ON COLUMN application_installation.created_at_utc IS \'(DC2Type:datetime_immutable)\'');
        $this->addSql('COMMENT ON COLUMN application_installation.update_at_utc IS \'(DC2Type:datetime_immutable)\'');
        $this->addSql('COMMENT ON COLUMN application_installation.bitrix_24_account_id IS \'(DC2Type:uuid)\'');
        $this->addSql('COMMENT ON COLUMN application_installation.contact_person_id IS \'(DC2Type:uuid)\'');
        $this->addSql('COMMENT ON COLUMN application_installation.bitrix_24_partner_contact_person_id IS \'(DC2Type:uuid)\'');
        $this->addSql('COMMENT ON COLUMN application_installation.bitrix_24_partner_id IS \'(DC2Type:uuid)\'');
        $this->addSql('CREATE TABLE bitrix24account (id UUID NOT NULL, b24_user_id INT NOT NULL, is_b24_user_admin BOOLEAN NOT NULL, member_id VARCHAR(255) NOT NULL, is_master_account BOOLEAN DEFAULT NULL, domain_url VARCHAR(255) NOT NULL, status VARCHAR(255) NOT NULL, application_token VARCHAR(255) DEFAULT NULL, created_at_utc TIMESTAMP(3) WITHOUT TIME ZONE NOT NULL, updated_at_utc TIMESTAMP(3) WITHOUT TIME ZONE NOT NULL, application_version INT NOT NULL, comment TEXT DEFAULT NULL, auth_token_access_token VARCHAR(255) NOT NULL, auth_token_refresh_token VARCHAR(255) NOT NULL, auth_token_expires BIGINT NOT NULL, auth_token_expires_in INT DEFAULT NULL, application_scope_current_scope JSON DEFAULT NULL, PRIMARY KEY(id))');
        $this->addSql('COMMENT ON COLUMN bitrix24account.id IS \'(DC2Type:uuid)\'');
        $this->addSql('COMMENT ON COLUMN bitrix24account.created_at_utc IS \'(DC2Type:datetime_immutable)\'');
        $this->addSql('COMMENT ON COLUMN bitrix24account.updated_at_utc IS \'(DC2Type:datetime_immutable)\'');
    }

    public function down(Schema $schema): void
    {
        if ('postgresql' === $this->connection->getDatabasePlatform()->getName()) {
            $this->addSql('CREATE SCHEMA public');
        }
        $this->addSql('DROP TABLE application_installation');
        $this->addSql('DROP TABLE bitrix24account');
    }
}
