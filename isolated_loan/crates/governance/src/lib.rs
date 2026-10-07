//! Authority separation for the V2 programs (Story 19.5).
//!
//! Every V2 program keeps one `Config` account holding these keys. The Squads vault PDA is the
//! only key that can rotate them, and it is also the program's upgrade authority. Operational keys
//! (AI worker, keeper) run jobs; they can never change financial policy or rotate anyone.

use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub struct Authorities {
    /// Squads vault PDA. Rotates every other key and holds the upgrade authority.
    pub governance: Pubkey,
    /// Registers and replaces the AI worker. Not a financial role.
    pub ai_admin: Pubkey,
    /// Answers AI requests. Operational.
    pub ai_worker: Pubkey,
    /// Administers the liquidation-ticket pool's parameters.
    pub liquidation_pool_admin: Pubkey,
    /// Issues credentials (later epics).
    pub credential_issuer: Pubkey,
    /// Triggers scheduled settlement checks. Operational and permissionless in effect.
    pub keeper: Pubkey,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Governance,
    AiAdmin,
    AiWorker,
    LiquidationPoolAdmin,
    CredentialIssuer,
    Keeper,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GovernanceError {
    /// A key is the default pubkey.
    UnsetKey,
    /// Two roles share one key, which would merge their powers.
    SharedKey,
    /// The signer does not hold the role the instruction needs.
    WrongAuthority,
}

/// Roles that may change financial policy or rotate keys. Operational roles never appear here.
pub const POLICY_ROLES: [Role; 1] = [Role::Governance];

impl Authorities {
    pub fn key(&self, role: Role) -> Pubkey {
        match role {
            Role::Governance => self.governance,
            Role::AiAdmin => self.ai_admin,
            Role::AiWorker => self.ai_worker,
            Role::LiquidationPoolAdmin => self.liquidation_pool_admin,
            Role::CredentialIssuer => self.credential_issuer,
            Role::Keeper => self.keeper,
        }
    }

    fn all(&self) -> [Pubkey; 6] {
        [self.governance, self.ai_admin, self.ai_worker, self.liquidation_pool_admin, self.credential_issuer, self.keeper]
    }

    /// Every key set and no two roles sharing a key. Checked at init and on every rotation.
    pub fn validate(&self) -> core::result::Result<(), GovernanceError> {
        let keys = self.all();
        if keys.iter().any(|k| *k == Pubkey::default()) {
            return Err(GovernanceError::UnsetKey);
        }
        for i in 0..keys.len() {
            for j in (i + 1)..keys.len() {
                if keys[i] == keys[j] {
                    return Err(GovernanceError::SharedKey);
                }
            }
        }
        Ok(())
    }

    pub fn require(&self, role: Role, signer: &Pubkey) -> core::result::Result<(), GovernanceError> {
        if self.key(role) == *signer {
            Ok(())
        } else {
            Err(GovernanceError::WrongAuthority)
        }
    }

    /// Rotation is governance-only, and the result must still validate.
    pub fn rotate(&self, signer: &Pubkey, next: Authorities) -> core::result::Result<Authorities, GovernanceError> {
        self.require(Role::Governance, signer)?;
        next.validate()?;
        Ok(next)
    }

    /// Financial policy changes (caps, fees, pool parameters) need governance, nothing else.
    pub fn require_policy(&self, signer: &Pubkey) -> core::result::Result<(), GovernanceError> {
        if POLICY_ROLES.iter().any(|r| self.key(*r) == *signer) {
            Ok(())
        } else {
            Err(GovernanceError::WrongAuthority)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys() -> Authorities {
        Authorities {
            governance: Pubkey::new_unique(),
            ai_admin: Pubkey::new_unique(),
            ai_worker: Pubkey::new_unique(),
            liquidation_pool_admin: Pubkey::new_unique(),
            credential_issuer: Pubkey::new_unique(),
            keeper: Pubkey::new_unique(),
        }
    }

    #[test]
    fn distinct_keys_validate() {
        assert_eq!(keys().validate(), Ok(()));
    }

    #[test]
    fn shared_or_unset_keys_fail() {
        let mut a = keys();
        a.keeper = a.ai_admin;
        assert_eq!(a.validate(), Err(GovernanceError::SharedKey));
        let mut b = keys();
        b.credential_issuer = Pubkey::default();
        assert_eq!(b.validate(), Err(GovernanceError::UnsetKey));
        // The legacy pattern: the AI admin also running the liquidation pool.
        let mut c = keys();
        c.liquidation_pool_admin = c.ai_admin;
        assert_eq!(c.validate(), Err(GovernanceError::SharedKey));
    }

    #[test]
    fn only_governance_rotates() {
        let a = keys();
        let next = keys();
        for op in [a.ai_admin, a.ai_worker, a.liquidation_pool_admin, a.credential_issuer, a.keeper] {
            assert_eq!(a.rotate(&op, next), Err(GovernanceError::WrongAuthority));
        }
        assert_eq!(a.rotate(&a.governance, next), Ok(next));
        let mut bad = keys();
        bad.keeper = bad.governance;
        assert_eq!(a.rotate(&a.governance, bad), Err(GovernanceError::SharedKey));
    }

    #[test]
    fn operational_keys_cannot_change_policy() {
        let a = keys();
        for op in [a.ai_admin, a.ai_worker, a.liquidation_pool_admin, a.credential_issuer, a.keeper] {
            assert_eq!(a.require_policy(&op), Err(GovernanceError::WrongAuthority));
        }
        assert_eq!(a.require_policy(&a.governance), Ok(()));
    }

    #[test]
    fn roles_check_their_own_key() {
        let a = keys();
        assert_eq!(a.require(Role::Keeper, &a.keeper), Ok(()));
        assert_eq!(a.require(Role::Keeper, &a.ai_worker), Err(GovernanceError::WrongAuthority));
    }
}
