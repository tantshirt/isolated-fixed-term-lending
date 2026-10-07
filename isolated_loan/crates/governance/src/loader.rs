//! Minimal loader-v3 metadata checks. The loader owns and writes both accounts.
//! Read only its fixed metadata; do not pull a general bincode decoder into V2 SBF.
use anchor_lang::prelude::*;

pub const LOADER: Pubkey = pubkey!("BPFLoaderUpgradeab1e11111111111111111111111");

/// Matches loader-v3 Program (tag 2, address) and ProgramData (tag 3, slot,
/// Some authority) metadata. Immutable programs and malformed records fail closed.
pub fn is_upgrade_authority(program: &AccountInfo, data: &AccountInfo, expected_program: &Pubkey, payer: &Pubkey) -> bool {
    if program.key != expected_program || !program.executable || program.owner != &LOADER || data.owner != &LOADER || data.executable {
        return false;
    }
    let (Ok(program_bytes), Ok(data_bytes)) = (program.try_borrow_data(), data.try_borrow_data()) else { return false; };
    valid_metadata(&program_bytes, &data_bytes, data.key, payer)
}

fn valid_metadata(program: &[u8], data: &[u8], address: &Pubkey, payer: &Pubkey) -> bool {
    program.get(..4) == Some(&2u32.to_le_bytes())
        && program.get(4..36) == Some(address.as_ref())
        && data.get(..4) == Some(&3u32.to_le_bytes())
        && data.get(12) == Some(&1)
        && data.get(13..45) == Some(payer.as_ref())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checks_the_complete_loader_authority_chain() {
        let id = Pubkey::new_unique();
        let address = Pubkey::new_unique();
        let payer = Pubkey::new_unique();
        let stranger = Pubkey::new_unique();
        let mut program = [2u32.to_le_bytes().as_slice(), address.as_ref()].concat();
        let mut data = [3u32.to_le_bytes().as_slice(), &42u64.to_le_bytes(), &[1], payer.as_ref(), &[0; 64]].concat();
        let (mut pl, mut dl) = (1, 1);
        let p = AccountInfo::new(&id, false, false, &mut pl, &mut program, &LOADER, true);
        let d = AccountInfo::new(&address, false, false, &mut dl, &mut data, &LOADER, false);
        assert!(is_upgrade_authority(&p, &d, &id, &payer));
        assert!(!is_upgrade_authority(&p, &d, &stranger, &payer));
        assert!(!is_upgrade_authority(&p, &d, &id, &stranger));
        let mut wrong = p.clone(); wrong.owner = &stranger;
        assert!(!is_upgrade_authority(&wrong, &d, &id, &payer));
        wrong = p.clone(); wrong.executable = false;
        assert!(!is_upgrade_authority(&wrong, &d, &id, &payer));
        let mut wrong = d.clone(); wrong.owner = &stranger;
        assert!(!is_upgrade_authority(&p, &wrong, &id, &payer));
        wrong = d.clone(); wrong.key = &stranger;
        assert!(!is_upgrade_authority(&p, &wrong, &id, &payer));
        wrong = d.clone(); wrong.executable = true;
        assert!(!is_upgrade_authority(&p, &wrong, &id, &payer));
    }

    #[test]
    fn rejects_truncated_wrong_variants_and_immutable_metadata() {
        let address = Pubkey::new_unique(); let payer = Pubkey::new_unique();
        let program = [2u32.to_le_bytes().as_slice(), address.as_ref()].concat();
        let data = [3u32.to_le_bytes().as_slice(), &42u64.to_le_bytes(), &[1], payer.as_ref()].concat();
        assert!(valid_metadata(&program, &data, &address, &payer));
        for n in 0..program.len() { assert!(!valid_metadata(&program[..n], &data, &address, &payer)); }
        for n in 0..data.len() { assert!(!valid_metadata(&program, &data[..n], &address, &payer)); }
        for tag in [0, 1, 3, 4] { let mut bad=program.clone();bad[0]=tag;assert!(!valid_metadata(&bad,&data,&address,&payer)); }
        for tag in [0, 1, 2, 4] { let mut bad=data.clone();bad[0]=tag;assert!(!valid_metadata(&program,&bad,&address,&payer)); }
        for option in [0, 2, 255] { let mut bad=data.clone();bad[12]=option;assert!(!valid_metadata(&program,&bad,&address,&payer)); }
    }
}
